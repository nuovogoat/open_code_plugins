export interface PluginLocation {
  directory: string
  project: {
    id: string
    directory: string
    canonical: string
  }
}

export interface SessionInfo {
  id: string
  title?: string
}

export interface SessionPage {
  data: SessionInfo[]
  cursor?: {
    next?: string
  }
}

export interface CreatedSessionEvent {
  type: string
  data?: {
    sessionID?: string
    projectID?: string
    title?: string
  }
}

export interface PluginContext {
  location: PluginLocation
  session: {
    hook(kind: "title", callback: (event: { result?: string }) => void): Promise<unknown>
    list(input: {
      directory?: string
      cursor?: string
      limit: number
    }): Promise<SessionPage>
    update(input: { sessionID: string; title: string }): Promise<void>
  }
  event: {
    subscribe(options: { signal: AbortSignal }): AsyncIterable<CreatedSessionEvent>
  }
}

export interface SyncStats {
  pages: number
  renamed: number
  failed: number
}

const PAGE_SIZE = 100
const UPDATE_CONCURRENCY = 8
export const MAX_TAB_TITLE_LENGTH = 80

function isUnsafeTitleCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    codePoint === 0x200b ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x2028 && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f)
  )
}

/** Keep terminal titles printable without removing meaningful ZWJ/ZWNJ characters. */
export function sanitizeTabTitle(value: string): string {
  if (typeof value !== "string") return ""

  let clean = ""
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && !isUnsafeTitleCodePoint(codePoint)) {
      clean += character
    }
  }

  const characters = Array.from(clean.trim())
  if (characters.length <= MAX_TAB_TITLE_LENGTH) return characters.join("")
  return `${characters.slice(0, MAX_TAB_TITLE_LENGTH - 1).join("")}…`
}

function reportError(message: string): void {
  // Never log session IDs, pagination cursors, paths or provider/API messages.
  console.error(`[project-folder-tabs] ${message}`)
}

/** Return the last path component on either Windows or POSIX hosts. */
export function folderName(directory: string): string {
  if (typeof directory !== "string") return ""

  const withoutTrailingSeparators = directory.replace(/[\\/]+$/u, "")
  if (/^[A-Za-z]:$/u.test(withoutTrailingSeparators)) return ""
  const name = withoutTrailingSeparators.split(/[\\/]/u).pop()?.trim() ?? ""
  return name
}

export function projectFolderName(location: PluginLocation): string {
  const candidates = [
    location?.project?.canonical,
    location?.project?.directory,
    location?.directory,
  ]

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue
    const name = sanitizeTabTitle(folderName(candidate))
    if (name) return name
  }

  return "Project"
}

async function renameBatch(
  ctx: PluginContext,
  sessions: SessionInfo[],
  title: string,
): Promise<number> {
  const results = await Promise.allSettled(
    sessions.map(async (session) => {
      await ctx.session.update({ sessionID: session.id, title })
    }),
  )
  return results.filter((result) => result.status === "rejected").length
}

/**
 * Rename existing sessions without allowing one bad page or update to break
 * plugin loading. Pagination is bounded by cycle detection, not a session cap.
 */
export async function syncExistingSessions(
  ctx: PluginContext,
  title = projectFolderName(ctx.location),
): Promise<SyncStats> {
  const stats: SyncStats = { pages: 0, renamed: 0, failed: 0 }
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  while (true) {
    let page: SessionPage
    try {
      page = await ctx.session.list(
        cursor === undefined
          ? { directory: ctx.location.directory, limit: PAGE_SIZE }
          : { cursor, limit: PAGE_SIZE },
      )
    } catch (error) {
      reportError("could not list sessions")
      break
    }

    stats.pages++
    const sessions = Array.isArray(page?.data) ? page.data : []
    const pending = sessions.filter(
      (session) =>
        session && typeof session.id === "string" && session.title !== title,
    )

    for (let offset = 0; offset < pending.length; offset += UPDATE_CONCURRENCY) {
      const batch = pending.slice(offset, offset + UPDATE_CONCURRENCY)
      const failed = await renameBatch(ctx, batch, title)
      stats.renamed += batch.length - failed
      stats.failed += failed
      if (failed > 0) {
        reportError(`could not rename ${failed} session(s)`)
      }
    }

    const next = page?.cursor?.next
    if (typeof next !== "string" || !next || seenCursors.has(next)) {
      if (next && seenCursors.has(next)) {
        reportError("stopped a repeated pagination cursor")
      }
      break
    }

    seenCursors.add(next)
    cursor = next
  }

  return stats
}

export function createdSessionID(
  event: CreatedSessionEvent,
  projectID: string,
  title: string,
): string | undefined {
  if (event?.type !== "session.created") return undefined
  const data = event.data
  if (!data || data.projectID !== projectID || data.title === title) {
    return undefined
  }
  return typeof data.sessionID === "string" && data.sessionID
    ? data.sessionID
    : undefined
}

/** Resolve after the event stream ends or aborts; never reject into a void task. */
export async function watchCreatedSessions(
  ctx: PluginContext,
  title: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (signal.aborted) return
    for await (const event of ctx.event.subscribe({ signal })) {
      if (signal.aborted) break
      const sessionID = createdSessionID(event, ctx.location.project.id, title)
      if (!sessionID) continue

      try {
        await ctx.session.update({ sessionID, title })
      } catch (error) {
        reportError("could not rename new session")
      }
    }
  } catch (error) {
    if (!signal.aborted) reportError("session event stream stopped")
  }
}

export async function setupProjectFolderTabs(
  ctx: PluginContext,
): Promise<() => void> {
  const title = projectFolderName(ctx.location)
  const controller = new AbortController()

  await ctx.session.hook("title", (event) => {
    event.result = title
  })

  void watchCreatedSessions(ctx, title, controller.signal)

  try {
    await syncExistingSessions(ctx, title)
  } catch (error) {
    // Keep the title hook and watcher alive even if a malformed client response
    // gets past the defensive synchronization logic.
    reportError("initial synchronization stopped")
  }

  return () => controller.abort()
}
