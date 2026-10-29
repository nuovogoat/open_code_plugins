import assert from "node:assert/strict"
import test from "node:test"
import {
  setupProjectFolderTabs,
  syncExistingSessions,
  watchCreatedSessions,
  type PluginContext,
} from "../core.ts"

// These tests simulate what happens after an OpenCode update changes or
// removes parts of the plugin context API. The plugin must never reject during
// setup, and each missing capability must degrade to a single generic log line.

const location: PluginContext["location"] = {
  directory: "C:\\drift\\checkout",
  project: {
    id: "drift-project",
    directory: "C:\\drift\\checkout",
    canonical: "C:\\drift\\project",
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

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = console.error
  console.error = (...parts: unknown[]) => lines.push(parts.map(String).join(" "))
  return {
    lines,
    restore: () => {
      console.error = original
    },
  }
}

test("drift: setup survives when the title hook API is removed", async () => {
  const updates: string[] = []
  const ctx = context({
    session: {
      async list() {
        return { data: [{ id: "ses_existing", title: "Old" }] }
      },
      async update(input) {
        updates.push(input.sessionID)
      },
    },
  })
  delete (ctx.session as Record<string, unknown>).hook

  const cleanup = await setupProjectFolderTabs(ctx)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(updates, ["ses_existing"])
  assert.doesNotThrow(cleanup)
})

test("drift: setup survives when title hook registration throws", async () => {
  const logged = captureLogs()
  const updates: string[] = []
  const ctx = context({
    session: {
      async hook() {
        throw new Error("hook API changed")
      },
      async list() {
        return { data: [{ id: "ses_existing", title: "Old" }] }
      },
      async update(input) {
        updates.push(input.sessionID)
      },
    },
  })

  try {
    const cleanup = await setupProjectFolderTabs(ctx)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(updates, ["ses_existing"])
    assert.doesNotThrow(cleanup)
  } finally {
    logged.restore()
  }
  assert.ok(logged.lines.some((line) => line.includes("title hook unavailable")))
})

test("drift: setup survives when the event stream API is removed", async () => {
  const updates: string[] = []
  const ctx = context({
    session: {
      async list() {
        return { data: [{ id: "ses_existing", title: "Old" }] }
      },
      async update(input) {
        updates.push(input.sessionID)
      },
    },
  })
  ;(ctx.event as Record<string, unknown>) = {}

  const cleanup = await setupProjectFolderTabs(ctx)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(updates, ["ses_existing"])
  assert.doesNotThrow(cleanup)
})

test("drift: the title hook callback tolerates null, frozen and missing events", async () => {
  let callback: ((event: { result?: string }) => void) | undefined
  const ctx = context({
    session: {
      async hook(_kind: unknown, cb: (event: { result?: string }) => void) {
        callback = cb
      },
      async list() {
        return { data: [] }
      },
      async update() {},
    },
  })

  const cleanup = await setupProjectFolderTabs(ctx)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(callback)

  assert.doesNotThrow(() => callback!(undefined as unknown as { result?: string }))
  assert.doesNotThrow(() => callback!(null as unknown as { result?: string }))
  assert.doesNotThrow(() => callback!(Object.freeze({})))
  assert.doesNotThrow(() => callback!({} as { result?: string }))

  const mutable: { result?: string } = {}
  callback!(mutable)
  assert.equal(mutable.result, "project")
  cleanup()
})

test("drift: sync returns safely when the session APIs are removed", async () => {
  const logged = captureLogs()
  const ctx = context({
    session: {} as unknown as PluginContext["session"],
    event: {} as unknown as PluginContext["event"],
  })

  try {
    const stats = await syncExistingSessions(ctx)
    assert.deepEqual(stats, { pages: 0, renamed: 0, failed: 0 })
  } finally {
    logged.restore()
  }
  assert.ok(
    logged.lines.some((line) => line.includes("synchronization API unavailable")),
  )
})

test("drift: watcher returns safely when the event stream API is removed", async () => {
  const logged = captureLogs()
  const ctx = context({ event: {} as unknown as PluginContext["event"] })

  try {
    await watchCreatedSessions(ctx, "project", new AbortController().signal)
  } finally {
    logged.restore()
  }
  assert.ok(
    logged.lines.some((line) => line.includes("session event stream unavailable")),
  )
})

test("drift: a pre-aborted watcher returns before touching a removed API", async () => {
  const logged = captureLogs()
  const ctx = context({ event: {} as unknown as PluginContext["event"] })

  try {
    await watchCreatedSessions(ctx, "project", AbortSignal.abort())
  } finally {
    logged.restore()
  }
  assert.equal(logged.lines.length, 0)
})

test("drift: setup survives a missing plugin context", async () => {
  const logged = captureLogs()
  try {
    const cleanup = await setupProjectFolderTabs(
      undefined as unknown as PluginContext,
    )
    assert.doesNotThrow(cleanup)
  } finally {
    logged.restore()
  }
  assert.ok(logged.lines.some((line) => line.includes("plugin context unavailable")))
})
