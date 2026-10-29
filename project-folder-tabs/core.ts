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

export interface LifecycleOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxPages?: number
  streamRetryDelayMs?: number
  update?: (sessionID: string) => Promise<void>
  onSubscribed?: () => void
}

const PAGE_SIZE = 100
const UPDATE_CONCURRENCY = 8
const API_TIMEOUT_MS = 10_000
const MAX_SYNC_PAGES = 1_000
const STREAM_RETRY_DELAY_MS = 1_000
export const MAX_TAB_TITLE_LENGTH = 80

type WaitResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected" | "timeout" | "aborted" }

/** Bound every external wait and always remove its timer and abort listener. */
async function waitFor<T>(
  operation: () => T | Promise<T>,
  options: LifecycleOptions = {},
): Promise<WaitResult<T>> {
  const signal = options.signal
  if (signal?.aborted) return { status: "aborted" }
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS

  return new Promise<WaitResult<T>>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: WaitResult<T>) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve(result)
    }
    const onAbort = () => finish({ status: "aborted" })

    signal?.addEventListener("abort", onAbort, { once: true })
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs)
    }
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish({ status: "fulfilled", value }),
        () => finish({ status: "rejected" }),
      )
  })
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  return new Promise<boolean>((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve(completed)
    }
    const onAbort = () => finish(false)
    const timer = setTimeout(() => finish(true), ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

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
  sessions: SessionInfo[],
  title: string,
  ctx: PluginContext,
  options: LifecycleOptions,
): Promise<number> {
  const results = await Promise.all(
    sessions.map(async (session) => {
      const update =
        options.update ??
        (async (sessionID: string) => {
          await ctx.session.update({ sessionID, title })
        })
      const result = await waitFor(() => update(session.id), options)
      return result.status === "fulfilled"
    }),
  )
  return results.filter((succeeded) => !succeeded).length
}

/**
 * Rename existing sessions without allowing bad pages, stuck requests or an
 * endless cursor sequence to break plugin loading or grow without bounds.
 */
export async function syncExistingSessions(
  ctx: PluginContext,
  title = projectFolderName(ctx.location),
  options: LifecycleOptions = {},
): Promise<SyncStats> {
  const stats: SyncStats = { pages: 0, renamed: 0, failed: 0 }
  if (
    typeof ctx?.session?.list !== "function" ||
    typeof ctx?.session?.update !== "function"
  ) {
    // Future OpenCode versions may rename or remove the session APIs; degrade
    // without throwing so the rest of the plugin keeps working.
    reportError("synchronization API unavailable")
    return stats
  }
  const maxPages = Math.max(1, options.maxPages ?? MAX_SYNC_PAGES)
  const seenCursors = new Set<string>()
  const seenSessions = new Set<string>()
  let cursor: string | undefined

  while (!options.signal?.aborted) {
    if (stats.pages >= maxPages) {
      reportError("synchronization page limit reached")
      break
    }

    const listed = await waitFor(
      () =>
        ctx.session.list(
          cursor === undefined
            ? { directory: ctx.location.directory, limit: PAGE_SIZE }
            : { cursor, limit: PAGE_SIZE },
        ),
      options,
    )
    if (listed.status === "aborted") break
    if (listed.status !== "fulfilled") {
      reportError("could not list sessions")
      break
    }

    const page = listed.value
    stats.pages++
    const sessions = Array.isArray(page?.data) ? page.data : []
    const pending = sessions.filter(
      (session) =>
        session &&
        typeof session.id === "string" &&
        session.title !== title &&
        !seenSessions.has(session.id),
    )
    for (const session of pending) seenSessions.add(session.id)

    for (let offset = 0; offset < pending.length; offset += UPDATE_CONCURRENCY) {
      if (options.signal?.aborted) break
      const batch = pending.slice(offset, offset + UPDATE_CONCURRENCY)
      const failed = await renameBatch(batch, title, ctx, options)
      stats.renamed += batch.length - failed
      stats.failed += failed
      if (failed > 0 && !options.signal?.aborted) {
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

export interface WatchResult {
  subscribed: boolean
  closed: boolean
}

/** Resolve after the event stream ends or aborts; never reject into a void task. */
export async function watchCreatedSessions(
  ctx: PluginContext,
  title: string,
  signal: AbortSignal,
  options: LifecycleOptions = {},
): Promise<WatchResult> {
  if (signal.aborted) return { subscribed: false, closed: true }
  const subscription = new AbortController()
  const abortSubscription = () => subscription.abort()
  signal.addEventListener("abort", abortSubscription, { once: true })
  let iterator: AsyncIterator<CreatedSessionEvent> | undefined
  let subscribed = false
  let finished = false
  let closed = false
  const effectiveOptions = { ...options, signal }
  try {
    if (typeof ctx?.event?.subscribe !== "function") {
      reportError("session event stream unavailable")
      return { subscribed, closed: true }
    }
    iterator = ctx.event.subscribe({ signal: subscription.signal })[Symbol.asyncIterator]()
    subscribed = true
    options.onSubscribed?.()

    while (!signal.aborted) {
      // An idle event stream is normal: only abort, not an arbitrary timeout,
      // should interrupt iterator.next().
      const next = await waitFor(() => iterator!.next(), {
        ...effectiveOptions,
        timeoutMs: 0,
      })
      if (next.status !== "fulfilled") break
      if (next.value.done) {
        finished = true
        break
      }

      const sessionID = createdSessionID(next.value.value, ctx.location.project.id, title)
      if (!sessionID) continue
      const update =
        options.update ??
        (async (id: string) => {
          await ctx.session.update({ sessionID: id, title })
        })
      const updated = await waitFor(() => update(sessionID), effectiveOptions)
      if (updated.status === "aborted") break
      if (updated.status !== "fulfilled") reportError("could not rename new session")
    }
  } catch (error) {
    if (!signal.aborted) reportError("session event stream stopped")
  } finally {
    // Abort every exited subscription, not only the whole plugin lifecycle.
    subscription.abort()
    if (!iterator || finished) closed = true
    else {
      // Some hostile iterators ignore abort. Bound return() as well, while
      // still giving well-behaved streams a chance to run their finally block.
      const returned = await waitFor(() => iterator.return?.(), { timeoutMs: 100 })
      closed = returned.status === "fulfilled"
    }
    signal.removeEventListener("abort", abortSubscription)
  }
  return { subscribed, closed }
}

/** Reconnect after stream failures and reconcile events missed while offline. */
async function superviseCreatedSessions(
  ctx: PluginContext,
  title: string,
  options: LifecycleOptions,
): Promise<void> {
  const signal = options.signal
  if (!signal) return
  const initialRetryDelay = Math.max(1, options.streamRetryDelayMs ?? STREAM_RETRY_DELAY_MS)
  let retryDelay = initialRetryDelay
  let firstSubscription = true
  let reconciliation: Promise<void> | undefined

  const reconcile = () => {
    if (signal.aborted || reconciliation) return
    reconciliation = (async () => {
      try {
        await syncExistingSessions(ctx, title, options)
      } catch (error) {
        if (!signal.aborted) reportError("initial synchronization stopped")
      } finally {
        reconciliation = undefined
      }
    })()
  }

  // The initial sync and first subscription overlap, so neither path can miss
  // a session created while the other one is starting.
  reconcile()
  while (!signal.aborted) {
    const watchedAt = Date.now()
    const result = await watchCreatedSessions(ctx, title, signal, {
      ...options,
      onSubscribed: () => {
        // Subscribe first, then reconcile while the replacement stream remains
        // active. There is no reconnect gap in which a creation can be lost.
        if (!firstSubscription) reconcile()
      },
    })
    firstSubscription = false
    if (signal.aborted || typeof ctx?.event?.subscribe !== "function") break
    if (!result.closed) {
      // Never pile a replacement onto a subscription we could not close.
      reportError("session event stream cleanup failed")
      break
    }
    if (!(await abortableDelay(retryDelay, signal))) break
    retryDelay = Date.now() - watchedAt >= 60_000
      ? initialRetryDelay
      : Math.min(retryDelay * 2, 30_000)
  }
}

function disposeRegistration(registration: unknown): void {
  try {
    const dispose = (registration as { dispose?: unknown } | undefined)?.dispose
    if (typeof dispose === "function") {
      void Promise.resolve()
        .then(() => dispose.call(registration))
        .catch(() => {})
    }
  } catch (error) {
    // A malformed future registration must not break plugin cleanup.
  }
}

async function initializeTitleHook(
  ctx: PluginContext,
  title: string,
  options: LifecycleOptions,
  setRegistration: (registration: unknown) => void,
): Promise<void> {
  if (typeof ctx?.session?.hook !== "function") return
  const registration = Promise.resolve().then(() =>
    ctx.session.hook("title", (event) => {
      try {
        if (event && typeof event === "object") event.result = title
      } catch (error) {
        // The runtime rejected the override; the watcher and sync still work.
      }
    }),
  )
  const result = await waitFor(() => registration, options)
  if (result.status === "fulfilled") {
    setRegistration(result.value)
    return
  }
  if (result.status !== "aborted") reportError("title hook unavailable")
  // If a late SDK response arrives after timeout or cleanup, dispose it rather
  // than leaving an orphaned hook behind.
  void registration.then(disposeRegistration, () => {})
}

/** Share concurrent renames of one session between the watcher and initial sync. */
function createUpdateCoordinator(
  ctx: PluginContext,
  title: string,
  options: LifecycleOptions,
): (sessionID: string) => Promise<void> {
  const inFlight = new Map<string, Promise<void>>()
  return async (sessionID: string) => {
    const existing = inFlight.get(sessionID)
    if (existing) return existing
    const task = (async () => {
      const result = await waitFor(
        () => ctx.session.update({ sessionID, title }),
        options,
      )
      if (result.status !== "fulfilled") throw new Error("update failed")
    })()
    inFlight.set(sessionID, task)
    try {
      await task
    } finally {
      if (inFlight.get(sessionID) === task) inFlight.delete(sessionID)
    }
  }
}

export async function setupProjectFolderTabs(
  ctx: PluginContext,
  options: LifecycleOptions = {},
): Promise<() => void> {
  if (!ctx || typeof ctx !== "object") {
    reportError("plugin context unavailable")
    return () => {}
  }
  const title = projectFolderName(ctx.location)
  const controller = new AbortController()
  const effectiveOptions: LifecycleOptions = { ...options, signal: controller.signal }
  effectiveOptions.update = createUpdateCoordinator(ctx, title, effectiveOptions)
  let hookRegistration: unknown

  const setRegistration = (registration: unknown) => {
    if (controller.signal.aborted) disposeRegistration(registration)
    else hookRegistration = registration
  }

  // Do not hold plugin setup hostage to a stalled SDK call or a large session
  // history. Cleanup is available immediately and aborts every background path.
  void initializeTitleHook(ctx, title, effectiveOptions, setRegistration)
  void superviseCreatedSessions(ctx, title, effectiveOptions)

  return () => {
    controller.abort()
    const registration = hookRegistration
    hookRegistration = undefined
    if (registration !== undefined) disposeRegistration(registration)
  }
}
