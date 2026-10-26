import assert from "node:assert/strict"
import test from "node:test"
import {
  createdSessionID,
  folderName,
  projectFolderName,
  setupProjectFolderTabs,
  syncExistingSessions,
  watchCreatedSessions,
  type CreatedSessionEvent,
  type PluginContext,
  type SessionInfo,
} from "../core.ts"

const location: PluginContext["location"] = {
  directory: "C:\\work\\checkout",
  project: {
    id: "project-1",
    directory: "C:\\work\\checkout",
    canonical: "C:\\work\\my-project",
  },
}

function context(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    location,
    session: {
      async hook() {},
      async list() {
        return { data: [] }
      },
      async update() {},
    },
    event: {
      subscribe() {
        return (async function* () {})()
      },
    },
    ...overrides,
  }
}

test("folderName supports Windows, POSIX, Unicode and trailing separators", () => {
  const cases = new Map([
    ["C:\\work\\my-project", "my-project"],
    ["C:\\work\\my-project\\", "my-project"],
    ["C:/work/my-project/", "my-project"],
    ["/home/user/проект", "проект"],
    ["/home/user/проект///", "проект"],
    ["/", ""],
    ["C:\\", ""],
    ["", ""],
  ])

  for (const [input, expected] of cases) {
    assert.equal(folderName(input), expected, input)
  }
})

test("projectFolderName prefers the canonical project root and has safe fallbacks", () => {
  assert.equal(projectFolderName(location), "my-project")
  assert.equal(
    projectFolderName({
      directory: "/fallback/location",
      project: { id: "p", directory: "/fallback/project", canonical: "/" },
    }),
    "project",
  )
  assert.equal(
    projectFolderName({
      directory: "C:\\",
      project: { id: "p", directory: "", canonical: "" },
    }),
    "Project",
  )
})

test("initial sync paginates, skips current titles and uses cursor-only requests", async () => {
  const calls: unknown[] = []
  const updates: string[] = []
  const sessions: SessionInfo[] = Array.from({ length: 205 }, (_, index) => ({
    id: `ses_${index}`,
    title: index % 10 === 0 ? "my-project" : `Old ${index}`,
  }))
  const ctx = context({
    session: {
      async hook() {},
      async list(input) {
        calls.push(input)
        const page = input.cursor ? Number(input.cursor) : 0
        return {
          data: sessions.slice(page, page + 100),
          cursor: page + 100 < sessions.length ? { next: String(page + 100) } : {},
        }
      },
      async update(input) {
        updates.push(input.sessionID)
      },
    },
  })

  const stats = await syncExistingSessions(ctx)
  assert.deepEqual(stats, { pages: 3, renamed: 184, failed: 0 })
  assert.equal(updates.length, 184)
  assert.deepEqual(calls[0], {
    directory: "C:\\work\\checkout",
    limit: 100,
  })
  assert.deepEqual(calls[1], { cursor: "100", limit: 100 })
  assert.deepEqual(calls[2], { cursor: "200", limit: 100 })
})

test("a repeated cursor cannot cause an infinite loop", async () => {
  let pages = 0
  const ctx = context({
    session: {
      async hook() {},
      async list() {
        pages++
        return { data: [], cursor: { next: "same-cursor" } }
      },
      async update() {},
    },
  })

  const stats = await syncExistingSessions(ctx)
  assert.equal(stats.pages, 2)
  assert.equal(pages, 2)
})

test("list and update failures are contained", async () => {
  let lists = 0
  const ctx = context({
    session: {
      async hook() {},
      async list() {
        lists++
        if (lists === 2) throw new Error("list unavailable")
        return {
          data: [
            { id: "ses_ok", title: "old" },
            { id: "ses_fail", title: "old" },
          ],
          cursor: { next: "page-2" },
        }
      },
      async update(input) {
        if (input.sessionID === "ses_fail") throw new Error("update unavailable")
      },
    },
  })

  const stats = await syncExistingSessions(ctx)
  assert.deepEqual(stats, { pages: 1, renamed: 1, failed: 1 })
})

test("createdSessionID validates event type, project and payload", () => {
  const event: CreatedSessionEvent = {
    type: "session.created",
    data: { sessionID: "ses_1", projectID: "project-1", title: "Session" },
  }
  assert.equal(createdSessionID(event, "project-1", "my-project"), "ses_1")
  assert.equal(createdSessionID(event, "other", "my-project"), undefined)
  assert.equal(
    createdSessionID(
      { type: "session.updated", data: event.data },
      "project-1",
      "my-project",
    ),
    undefined,
  )
  assert.equal(
    createdSessionID(
      {
        type: "session.created",
        data: { ...event.data, title: "my-project" },
      },
      "project-1",
      "my-project",
    ),
    undefined,
  )
  assert.equal(
    createdSessionID({ type: "session.created" }, "project-1", "my-project"),
    undefined,
  )
})

test("new sessions are renamed and event/update failures do not reject", async () => {
  const updates: string[] = []
  const events: CreatedSessionEvent[] = [
    { type: "message.updated", data: { sessionID: "ignored" } },
    {
      type: "session.created",
      data: { sessionID: "ses_other", projectID: "other", title: "Session" },
    },
    {
      type: "session.created",
      data: { sessionID: "ses_1", projectID: "project-1", title: "Session" },
    },
    {
      type: "session.created",
      data: { sessionID: "ses_2", projectID: "project-1", title: "Session" },
    },
    {
      type: "session.created",
      data: { sessionID: "ses_3", projectID: "project-1", title: "my-project" },
    },
  ]
  const ctx = context({
    session: {
      async hook() {},
      async list() {
        return { data: [] }
      },
      async update(input) {
        updates.push(input.sessionID)
        if (input.sessionID === "ses_2") throw new Error("transient")
      },
    },
    event: {
      subscribe() {
        return (async function* () {
          yield* events
          throw new Error("stream disconnected")
        })()
      },
    },
  })

  await watchCreatedSessions(ctx, "my-project", new AbortController().signal)
  assert.deepEqual(updates, ["ses_1", "ses_2"])
})

test("logs contain no session IDs, cursors, paths or raw error details", async () => {
  const logged: string[] = []
  const originalError = console.error
  console.error = (...parts: unknown[]) => logged.push(parts.map(String).join(" "))
  const ctx = context({
    session: {
      async hook() {},
      async list() {
        return {
          data: [{ id: "ses_PRIVATE_IDENTIFIER", title: "Old" }],
          cursor: { next: "PRIVATE_CURSOR" },
        }
      },
      async update() {
        throw new Error("PRIVATE_API_DETAILS C:\\private\\project")
      },
    },
    event: {
      subscribe() {
        return (async function* () {
          yield {
            type: "session.created",
            data: {
              sessionID: "ses_PRIVATE_IDENTIFIER",
              projectID: "project-1",
              title: "Session",
            },
          }
          throw new Error("PRIVATE_STREAM_DETAILS")
        })()
      },
    },
  })

  try {
    await syncExistingSessions(ctx)
    await watchCreatedSessions(ctx, "my-project", new AbortController().signal)
  } finally {
    console.error = originalError
  }

  assert.ok(logged.length >= 3)
  const output = logged.join("\n")
  assert.match(output, /\[project-folder-tabs\]/)
  assert.doesNotMatch(output, /PRIVATE|ses_|C:\\/i)
})

test("setup installs the title hook, renames existing sessions and aborts on cleanup", async () => {
  let titleHook: ((event: { result?: string }) => void) | undefined
  let subscriptionSignal: AbortSignal | undefined
  const updates: string[] = []
  const ctx = context({
    session: {
      async hook(_kind, callback) {
        titleHook = callback
      },
      async list() {
        return { data: [{ id: "ses_existing", title: "Old" }] }
      },
      async update(input) {
        updates.push(input.sessionID)
      },
    },
    event: {
      subscribe({ signal }) {
        subscriptionSignal = signal
        return (async function* () {
          yield {
            type: "session.created",
            data: { sessionID: "ses_new", projectID: "project-1", title: "Session" },
          }
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener("abort", () => resolve(), { once: true })
          })
        })()
      },
    },
  })

  const cleanup = await setupProjectFolderTabs(ctx)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(titleHook)
  const generated: { result?: string } = {}
  titleHook(generated)
  assert.equal(generated.result, "my-project")
  assert.deepEqual(updates.sort(), ["ses_existing", "ses_new"])
  assert.equal(subscriptionSignal?.aborted, false)

  cleanup()
  assert.equal(subscriptionSignal?.aborted, true)
})
