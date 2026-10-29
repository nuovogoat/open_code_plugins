import assert from "node:assert/strict"
import test from "node:test"
import {
  setupProjectFolderTabs,
  syncExistingSessions,
  watchCreatedSessions,
  type CreatedSessionEvent,
  type PluginContext,
} from "../core.ts"

const location: PluginContext["location"] = {
  directory: "C:\\lifecycle\\checkout",
  project: {
    id: "lifecycle-project",
    directory: "C:\\lifecycle\\checkout",
    canonical: "C:\\lifecycle\\project",
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

function silenceLogs(): () => void {
  const original = console.error
  console.error = () => {}
  return () => {
    console.error = original
  }
}

async function eventually(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("condition was not reached before timeout")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

test("lifecycle: setup returns and cleanup closes a stream when every SDK call hangs", { timeout: 1_000 }, async () => {
  const restore = silenceLogs()
  let closed = 0
  let updates = 0
  const never = () => new Promise<never>(() => {})
  const ctx = context({
    session: {
      hook: never,
      list: never,
      async update() {
        updates++
      },
    },
    event: {
      subscribe() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: never,
              async return() {
                closed++
                return { done: true, value: undefined }
              },
            }
          },
        }
      },
    },
  })

  try {
    const cleanup = await setupProjectFolderTabs(ctx, { timeoutMs: 5_000 })
    cleanup()
    cleanup()
    await eventually(() => closed === 1)
    assert.equal(updates, 0)
  } finally {
    restore()
  }
})

test("lifecycle: a stuck list and a stuck update have bounded deadlines", { timeout: 1_000 }, async () => {
  const restore = silenceLogs()
  try {
    const stuckList = context({
      session: {
        async hook() {},
        list: () => new Promise<never>(() => {}),
        async update() {},
      },
    })
    assert.deepEqual(await syncExistingSessions(stuckList, "project", { timeoutMs: 5 }), {
      pages: 0,
      renamed: 0,
      failed: 0,
    })

    const stuckUpdate = context({
      session: {
        async hook() {},
        async list() {
          return { data: [{ id: "ses_stuck", title: "old" }] }
        },
        update: () => new Promise<never>(() => {}),
      },
    })
    assert.deepEqual(await syncExistingSessions(stuckUpdate, "project", { timeoutMs: 5 }), {
      pages: 1,
      renamed: 0,
      failed: 1,
    })
  } finally {
    restore()
  }
})

test("lifecycle: a stuck event update cannot block later sessions", { timeout: 1_000 }, async () => {
  const restore = silenceLogs()
  const attempts: string[] = []
  const ctx = context({
    session: {
      async hook() {},
      async list() {
        return { data: [] }
      },
      update(input) {
        attempts.push(input.sessionID)
        return input.sessionID === "ses_stuck"
          ? new Promise<never>(() => {})
          : Promise.resolve()
      },
    },
    event: {
      subscribe() {
        return (async function* (): AsyncGenerator<CreatedSessionEvent> {
          for (const sessionID of ["ses_stuck", "ses_ok"]) {
            yield {
              type: "session.created",
              data: { sessionID, projectID: "lifecycle-project", title: "old" },
            }
          }
        })()
      },
    },
  })

  try {
    await watchCreatedSessions(ctx, "project", new AbortController().signal, {
      timeoutMs: 5,
    })
    assert.deepEqual(attempts, ["ses_stuck", "ses_ok"])
  } finally {
    restore()
  }
})

test("lifecycle: abort closes a never-yielding iterator and bounds a hostile return", { timeout: 1_000 }, async () => {
  for (const returnHangs of [false, true]) {
    let returned = 0
    const controller = new AbortController()
    const ctx = context({
      event: {
        subscribe() {
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () => new Promise<never>(() => {}),
                return: () => {
                  returned++
                  return returnHangs
                    ? new Promise<never>(() => {})
                    : Promise.resolve({ done: true, value: undefined })
                },
              }
            },
          }
        },
      },
    })
    const watching = watchCreatedSessions(ctx, "project", controller.signal)
    controller.abort()
    await watching
    assert.equal(returned, 1)
  }
})

test("lifecycle: endless unique cursors stop at a hard page budget", { timeout: 1_000 }, async () => {
  const restore = silenceLogs()
  let pages = 0
  const ctx = context({
    session: {
      async hook() {},
      async list() {
        pages++
        return { data: [], cursor: { next: `unique-${pages}` } }
      },
      async update() {},
    },
  })

  try {
    const stats = await syncExistingSessions(ctx, "project", { maxPages: 25 })
    assert.equal(stats.pages, 25)
    assert.equal(pages, 25)
  } finally {
    restore()
  }
})

test("lifecycle: initial sync and the watcher share one in-flight rename", { timeout: 1_000 }, async () => {
  const restore = silenceLogs()
  let updates = 0
  let releaseStream: (() => void) | undefined
  const ctx = context({
    session: {
      async hook() {},
      async list() {
        return { data: [{ id: "ses_same", title: "old" }] }
      },
      update() {
        updates++
        return new Promise<never>(() => {})
      },
    },
    event: {
      subscribe({ signal }) {
        return (async function* (): AsyncGenerator<CreatedSessionEvent> {
          yield {
            type: "session.created",
            data: { sessionID: "ses_same", projectID: "lifecycle-project", title: "old" },
          }
          await new Promise<void>((resolve) => {
            releaseStream = resolve
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
        })()
      },
    },
  })

  try {
    const cleanup = await setupProjectFolderTabs(ctx, { timeoutMs: 5_000 })
    await eventually(() => updates > 0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(updates, 1)
    cleanup()
    releaseStream?.()
  } finally {
    restore()
  }
})

test("lifecycle: a dropped event stream reconnects and reconciles missed sessions", { timeout: 1_000 }, async () => {
  const restore = silenceLogs()
  let subscriptions = 0
  const updates: string[] = []
  const ctx = context({
    session: {
      async hook() {},
      async list() {
        return { data: [] }
      },
      async update(input) {
        updates.push(input.sessionID)
      },
    },
    event: {
      subscribe({ signal }) {
        subscriptions++
        if (subscriptions === 1) {
          return (async function* (): AsyncGenerator<CreatedSessionEvent> {
            throw new Error("dropped")
          })()
        }
        return (async function* (): AsyncGenerator<CreatedSessionEvent> {
          yield {
            type: "session.created",
            data: { sessionID: "ses_recovered", projectID: "lifecycle-project", title: "old" },
          }
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener("abort", () => resolve(), { once: true })
          })
        })()
      },
    },
  })

  try {
    const cleanup = await setupProjectFolderTabs(ctx, {
      streamRetryDelayMs: 5,
      timeoutMs: 100,
    })
    await eventually(() => updates.includes("ses_recovered"))
    cleanup()
    assert.ok(subscriptions >= 2)
  } finally {
    restore()
  }
})

test("lifecycle: ready and late hook registrations are disposed exactly once", { timeout: 1_000 }, async () => {
  const restore = silenceLogs()
  try {
    let readyDisposals = 0
    const ready = context({
      session: {
        async hook() {
          return { async dispose() { readyDisposals++ } }
        },
        async list() {
          return { data: [] }
        },
        async update() {},
      },
    })
    const cleanupReady = await setupProjectFolderTabs(ready)
    await new Promise((resolve) => setImmediate(resolve))
    cleanupReady()
    cleanupReady()
    await eventually(() => readyDisposals === 1)

    let lateDisposals = 0
    let resolveHook: ((value: { dispose: () => Promise<void> }) => void) | undefined
    const late = context({
      session: {
        hook() {
          return new Promise<{ dispose: () => Promise<void> }>((resolve) => {
            resolveHook = resolve
          })
        },
        async list() {
          return { data: [] }
        },
        async update() {},
      },
    })
    const cleanupLate = await setupProjectFolderTabs(late)
    cleanupLate()
    resolveHook?.({ async dispose() { lateDisposals++ } })
    await eventually(() => lateDisposals === 1)
  } finally {
    restore()
  }
})

test("lifecycle: a page arriving after cleanup cannot trigger updates", { timeout: 1_000 }, async () => {
  const restore = silenceLogs()
  let updates = 0
  let resolveList: ((page: { data: Array<{ id: string; title: string }> }) => void) | undefined
  const ctx = context({
    session: {
      async hook() {},
      list() {
        return new Promise<{ data: Array<{ id: string; title: string }> }>((resolve) => {
          resolveList = resolve
        })
      },
      async update() {
        updates++
      },
    },
  })

  try {
    const cleanup = await setupProjectFolderTabs(ctx)
    cleanup()
    resolveList?.({ data: [{ id: "ses_late", title: "old" }] })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(updates, 0)
  } finally {
    restore()
  }
})

test("lifecycle: reconnect subscribes before reconciliation without a creation gap", { timeout: 1_000 }, async () => {
  const restore = silenceLogs()
  let subscriptions = 0
  let lists = 0
  let emitDuringSync: (() => void) | undefined
  const updates: string[] = []
  const event: CreatedSessionEvent = {
    type: "session.created",
    data: { sessionID: "ses_during_sync", projectID: "lifecycle-project", title: "old" },
  }
  const ctx = context({
    session: {
      async hook() {},
      async list() {
        lists++
        if (lists === 2) emitDuringSync?.()
        return { data: [] }
      },
      async update(input) {
        updates.push(input.sessionID)
      },
    },
    event: {
      subscribe() {
        subscriptions++
        if (subscriptions === 1) {
          return {
            [Symbol.asyncIterator]() {
              return {
                async next(): Promise<IteratorResult<CreatedSessionEvent>> {
                  throw new Error("dropped")
                },
                async return() {
                  return { done: true, value: undefined }
                },
              }
            },
          }
        }

        const queue: CreatedSessionEvent[] = []
        let waiting: ((result: IteratorResult<CreatedSessionEvent>) => void) | undefined
        emitDuringSync = () => {
          if (waiting) {
            const resolve = waiting
            waiting = undefined
            resolve({ done: false, value: event })
          } else queue.push(event)
        }
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<CreatedSessionEvent>> {
                const queued = queue.shift()
                if (queued) return Promise.resolve({ done: false, value: queued })
                return new Promise((resolve) => {
                  waiting = resolve
                })
              },
              async return() {
                return { done: true, value: undefined }
              },
            }
          },
        }
      },
    },
  })

  try {
    const cleanup = await setupProjectFolderTabs(ctx, {
      streamRetryDelayMs: 5,
      timeoutMs: 100,
    })
    await eventually(() => updates.includes("ses_during_sync"))
    cleanup()
    assert.equal(subscriptions, 2)
    assert.equal(lists, 2)
  } finally {
    restore()
  }
})

test("lifecycle: a removed event API degrades once without reconnect or sync loops", { timeout: 1_000 }, async () => {
  const original = console.error
  const logs: string[] = []
  console.error = (...parts: unknown[]) => logs.push(parts.join(" "))
  let lists = 0
  const ctx = context({
    session: {
      async hook() {},
      async list() {
        lists++
        return { data: [] }
      },
      async update() {},
    },
    event: {} as unknown as PluginContext["event"],
  })

  try {
    const cleanup = await setupProjectFolderTabs(ctx, { streamRetryDelayMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    cleanup()
    assert.equal(lists, 1)
    assert.equal(
      logs.filter((line) => line.includes("session event stream unavailable")).length,
      1,
    )
  } finally {
    console.error = original
  }
})

test("lifecycle: an unclosed stream is aborted and never replaced", { timeout: 1_000 }, async () => {
  const restore = silenceLogs()
  let subscriptions = 0
  let subscriptionSignal: AbortSignal | undefined
  const ctx = context({
    event: {
      subscribe({ signal }) {
        subscriptions++
        subscriptionSignal = signal
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<CreatedSessionEvent>> {
                throw new Error("dropped")
              },
              return: () => new Promise<never>(() => {}),
            }
          },
        }
      },
    },
  })

  try {
    const cleanup = await setupProjectFolderTabs(ctx, { streamRetryDelayMs: 1 })
    await eventually(() => subscriptionSignal?.aborted === true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    cleanup()
    assert.equal(subscriptions, 1)
  } finally {
    restore()
  }
})
