import assert from "node:assert/strict"
import test from "node:test"
import {
  disambiguateTabTitles,
  MAX_TAB_TITLE_LENGTH,
  setupProjectFolderTabs,
  type PluginContext,
} from "../core.ts"

function location(canonical: string, id = canonical): PluginContext["location"] {
  return {
    directory: canonical,
    project: { id, directory: canonical, canonical },
  }
}

async function eventually(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("condition was not reached before timeout")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

test("collision: unique names stay short and duplicate names gain minimal parent fragments", () => {
  const titles = disambiguateTabTitles([
    location("C:\\work\\client-a\\frontend"),
    location("D:\\archive\\client-b\\frontend"),
    location("E:\\projects\\backend"),
  ])
  assert.deepEqual(titles, [
    "frontend — client-a",
    "frontend — client-b",
    "backend",
  ])
})

test("collision: equal parent folders expand only until titles become unique", () => {
  const titles = disambiguateTabTitles([
    location("C:\\one\\shared\\frontend"),
    location("D:\\two\\shared\\frontend"),
  ])
  assert.deepEqual(titles, [
    "frontend — one/shared",
    "frontend — two/shared",
  ])
})

test("collision: path expansion is not limited by the number of projects", () => {
  const common = Array.from({ length: 8 }, (_, index) => `level-${index}`)
  const titles = disambiguateTabTitles([
    location(["C:", "one", ...common, "frontend"].join("\\")),
    location(["D:", "two", ...common, "frontend"].join("\\")),
  ])
  assert.deepEqual(titles, [
    `frontend — one/${common.join("/")}`,
    `frontend — two/${common.join("/")}`,
  ])
})

test("collision: 1,000 same-named folders receive unique bounded titles", () => {
  const locations = Array.from({ length: 1_000 }, (_, index) =>
    location(`C:\\clients\\client-${index}\\frontend`),
  )
  const titles = disambiguateTabTitles(locations)
  assert.equal(new Set(titles).size, 1_000)
  assert.equal(titles[0], "frontend — client-0")
  assert.equal(titles[999], "frontend — client-999")
  assert.ok(titles.every((title) => Array.from(title).length <= MAX_TAB_TITLE_LENGTH))
  assert.ok(titles.every((title) => !title.includes("C:") && !title.includes("clients")))
})

test("collision: long Unicode names reserve room for the distinguisher", () => {
  const base = "🚀".repeat(100)
  const titles = disambiguateTabTitles([
    location(`C:\\work\\client-a\\${base}`),
    location(`D:\\work\\client-b\\${base}`),
  ])
  assert.equal(new Set(titles).size, 2)
  assert.ok(titles[0].endsWith("— client-a"))
  assert.ok(titles[1].endsWith("— client-b"))
  assert.ok(titles.every((title) => Array.from(title).length <= MAX_TAB_TITLE_LENGTH))
})

test("collision: plugin instances for one canonical root keep the same short title", () => {
  const base = "x".repeat(100)
  const titles = disambiguateTabTitles([
    location(`C:\\work\\${base}`, "first"),
    location(`c:/work/${base}/`, "second"),
  ])
  assert.equal(new Set(titles).size, 1)
  assert.ok(!titles[0].includes("("))
  assert.ok(titles.every((title) => Array.from(title).length <= MAX_TAB_TITLE_LENGTH))
})

test("collision: exhausted distinct paths receive bounded numeric distinguishers", () => {
  const titles = disambiguateTabTitles([
    location("C:\\work\\frontend", "first"),
    location("D:\\work\\frontend", "second"),
  ])
  assert.equal(new Set(titles).size, 2)
  assert.ok(titles[0].endsWith("(1)"))
  assert.ok(titles[1].endsWith("(2)"))
  assert.ok(titles.every((title) => Array.from(title).length <= MAX_TAB_TITLE_LENGTH))
})

test("collision: live registry retitles existing sessions and restores short names on cleanup", async () => {
  const hooks = new Map<string, (event: { result?: string }) => void>()
  const updates = new Map<string, string[]>()

  function context(id: string, canonical: string): PluginContext {
    updates.set(id, [])
    return {
      location: location(canonical, id),
      session: {
        async hook(_kind, callback) {
          hooks.set(id, callback)
        },
        async list() {
          return { data: [{ id: `ses_${id}`, title: "old" }] }
        },
        async update(input) {
          updates.get(id)!.push(input.title)
        },
      },
      event: {
        subscribe({ signal }) {
          return (async function* () {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener("abort", () => resolve(), { once: true })
            })
          })()
        },
      },
    }
  }

  const cleanupA = await setupProjectFolderTabs(
    context("a", "C:\\work\\client-a\\frontend"),
  )
  const cleanupB = await setupProjectFolderTabs(
    context("b", "D:\\archive\\client-b\\frontend"),
  )

  try {
    await eventually(() => hooks.has("a") && hooks.has("b"))
    const titleA: { result?: string } = {}
    const titleB: { result?: string } = {}
    hooks.get("a")!(titleA)
    hooks.get("b")!(titleB)
    assert.equal(titleA.result, "frontend — client-a")
    assert.equal(titleB.result, "frontend — client-b")

    await eventually(() => updates.get("a")!.at(-1) === "frontend — client-a")
    await eventually(() => updates.get("b")!.at(-1) === "frontend — client-b")

    cleanupB()
    const restored: { result?: string } = {}
    hooks.get("a")!(restored)
    assert.equal(restored.result, "frontend")
    await eventually(() => updates.get("a")!.at(-1) === "frontend")
  } finally {
    cleanupA()
    cleanupB()
  }
})

test("collision: a late update cannot overwrite a newer disambiguated title", async () => {
  const updates: string[] = []
  let updateCalls = 0
  let releaseFirst: (() => void) | undefined
  const cleanups: Array<() => void> = []

  function context(id: string, canonical: string, withSession = false): PluginContext {
    return {
      location: location(canonical, id),
      session: {
        async hook() {},
        async list() {
          return { data: withSession ? [{ id: "ses_a", title: "old" }] : [] }
        },
        async update(input) {
          if (!withSession) return
          updateCalls++
          if (updateCalls === 1) {
            await new Promise<void>((resolve) => {
              releaseFirst = () => {
                releaseFirst = undefined
                updates.push(input.title)
                resolve()
              }
            })
            return
          }
          updates.push(input.title)
        },
      },
      event: {
        subscribe({ signal }) {
          return (async function* () {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener("abort", () => resolve(), { once: true })
            })
          })()
        },
      },
    }
  }

  try {
    cleanups.push(
      await setupProjectFolderTabs(context("a", "C:\\work\\client-a\\frontend", true)),
    )
    await eventually(() => releaseFirst !== undefined)
    cleanups.push(
      await setupProjectFolderTabs(context("b", "D:\\work\\client-b\\frontend")),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    releaseFirst!()
    await eventually(() => updates.at(-1) === "frontend — client-a")
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(updates.at(-1), "frontend — client-a")
  } finally {
    releaseFirst?.()
    for (const cleanup of cleanups.reverse()) cleanup()
  }
})

test("collision: the registry retains no raw paths and is empty after every cleanup", async () => {
  const isolated = await import(new URL("../core.ts?registry-privacy", import.meta.url).href)
  const registry = Reflect.get(
    globalThis,
    Symbol.for("opencode.project-folder-tabs.active-projects"),
  ) as Map<symbol, Record<string, unknown>>
  const secretRoot = "C:\\private\\customer-name"
  const cleanups: Array<() => void> = []

  function context(id: string): PluginContext {
    return {
      location: location(`${secretRoot}\\${id}\\frontend`, id),
      session: {
        async hook() {},
        async list() {
          return { data: [] }
        },
        async update() {},
      },
      event: {
        subscribe({ signal }) {
          return (async function* () {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener("abort", () => resolve(), { once: true })
            })
          })()
        },
      },
    }
  }

  try {
    cleanups.push(await isolated.setupProjectFolderTabs(context("client-a")))
    cleanups.push(await isolated.setupProjectFolderTabs(context("client-b")))
    assert.equal(registry.size, 2)
    for (const entry of registry.values()) {
      assert.equal("location" in entry, false)
      assert.deepEqual(Object.keys(entry.project as object).sort(), ["base", "key", "parents"])
      const retained = JSON.stringify(entry)
      assert.ok(!retained.includes(secretRoot))
      assert.ok(!retained.includes("C:\\private"))
    }
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup()
  }
  assert.equal(registry.size, 0)
})

test("collision: hot reload migrates legacy registry entries without dropping active projects", async () => {
  const isolated = await import(new URL("../core.ts?hot-reload-migration", import.meta.url).href)
  const registry = Reflect.get(
    globalThis,
    Symbol.for("opencode.project-folder-tabs.active-projects"),
  ) as Map<symbol, Record<string, any>>
  const legacyKey = Symbol("legacy-project")
  const legacyPath = "C:\\work\\client-a\\frontend"
  let restarts = 0
  const legacy = {
    location: location(legacyPath, "legacy"),
    title: "frontend",
    restart() {
      restarts++
    },
  }
  let cleanup: (() => void) | undefined
  registry.set(legacyKey, legacy)

  try {
    cleanup = await isolated.setupProjectFolderTabs({
      location: location("D:\\work\\client-b\\frontend", "current"),
      session: {
        async hook() {},
        async list() {
          return { data: [] }
        },
        async update() {},
      },
      event: {
        subscribe({ signal }) {
          return (async function* () {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener("abort", () => resolve(), { once: true })
            })
          })()
        },
      },
    })

    assert.equal(registry.size, 2)
    assert.equal("location" in legacy, false)
    assert.deepEqual(Object.keys(legacy.project).sort(), ["base", "key", "parents"])
    assert.ok(!JSON.stringify(legacy).includes(legacyPath))
    assert.equal(legacy.title, "frontend — client-a")
    assert.equal(restarts, 1)
    const current = [...registry.values()].find((entry) => entry !== legacy)
    assert.equal(current?.title, "frontend — client-b")

    cleanup()
    cleanup = undefined
    assert.equal(legacy.title, "frontend")
    assert.equal(restarts, 2)
  } finally {
    cleanup?.()
    registry.delete(legacyKey)
  }
  assert.equal(registry.size, 0)
})

test("collision: isolated OpenCode module graphs share the live project registry", async () => {
  const first = await import(new URL("../core.ts?registry-first", import.meta.url).href)
  const second = await import(new URL("../core.ts?registry-second", import.meta.url).href)
  const hooks = new Map<string, (event: { result?: string }) => void>()
  const cleanups: Array<() => void> = []

  function context(id: string, canonical: string): PluginContext {
    return {
      location: location(canonical, id),
      session: {
        async hook(_kind, callback) {
          hooks.set(id, callback)
        },
        async list() {
          return { data: [] }
        },
        async update() {},
      },
      event: {
        subscribe({ signal }) {
          return (async function* () {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener("abort", () => resolve(), { once: true })
            })
          })()
        },
      },
    }
  }

  try {
    cleanups.push(
      await first.setupProjectFolderTabs(context("a", "C:\\work\\client-a\\frontend")),
    )
    cleanups.push(
      await second.setupProjectFolderTabs(context("b", "D:\\work\\client-b\\frontend")),
    )
    await eventually(() => hooks.has("a") && hooks.has("b"))
    const titleA: { result?: string } = {}
    const titleB: { result?: string } = {}
    hooks.get("a")!(titleA)
    hooks.get("b")!(titleB)
    assert.equal(titleA.result, "frontend — client-a")
    assert.equal(titleB.result, "frontend — client-b")

    cleanups.pop()!()
    const restored: { result?: string } = {}
    hooks.get("a")!(restored)
    assert.equal(restored.result, "frontend")
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup()
  }
})
