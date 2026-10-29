import assert from "node:assert/strict"
import test from "node:test"
import { setupProjectFolderTabs, type PluginContext } from "../core.ts"

const gc = (globalThis as { gc?: () => void }).gc

test("memory: 3,000 hung setup/cleanup cycles leave no subscriptions or unbounded heap growth", { timeout: 60_000, skip: !gc }, async () => {
  const cycles = 3_000
  let active = 0
  let closed = 0
  let updates = 0

  function context(): PluginContext {
    const never = () => new Promise<never>(() => {})
    return {
      location: {
        directory: "C:\\memory\\checkout",
        project: {
          id: "memory-project",
          directory: "C:\\memory\\checkout",
          canonical: "C:\\memory\\project",
        },
      },
      session: {
        hook: never,
        list: never,
        async update() {
          updates++
        },
      },
      event: {
        subscribe() {
          active++
          return {
            [Symbol.asyncIterator]() {
              return {
                next: never,
                async return() {
                  active--
                  closed++
                  return { done: true, value: undefined }
                },
              }
            },
          }
        },
      },
    }
  }

  const restore = console.error
  console.error = () => {}
  try {
    for (let cycle = 0; cycle < 200; cycle++) {
      const cleanup = await setupProjectFolderTabs(context())
      cleanup()
    }
    await new Promise((resolve) => setImmediate(resolve))
    gc!()
    gc!()
    const baseline = process.memoryUsage().heapUsed

    for (let cycle = 0; cycle < cycles; cycle++) {
      const cleanup = await setupProjectFolderTabs(context())
      cleanup()
      if (cycle % 100 === 0) await new Promise((resolve) => setImmediate(resolve))
    }
    await new Promise((resolve) => setImmediate(resolve))
    gc!()
    gc!()
    const retained = process.memoryUsage().heapUsed - baseline

    const registry = Reflect.get(
      globalThis,
      Symbol.for("opencode.project-folder-tabs.active-projects"),
    ) as Map<symbol, unknown>
    assert.equal(registry.size, 0)
    assert.equal(active, 0)
    assert.equal(closed, cycles + 200)
    assert.equal(updates, 0)
    assert.ok(
      retained < 16 * 1024 * 1024,
      `retained heap grew by ${retained} bytes after ${cycles} cycles`,
    )
    console.log(JSON.stringify({ cycles, closed, retainedHeapBytes: retained }))
  } finally {
    console.error = restore
  }
})
