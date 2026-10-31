import assert from "node:assert/strict"
import test from "node:test"
import { setupModelAutoRouter, type PluginContext } from "../core.ts"

const gc = (globalThis as { gc?: () => void }).gc

test("memory: 3,000 setup/cleanup cycles leave no registrations, subscriptions or unbounded heap growth", { timeout: 60_000, skip: !gc }, async () => {
  const cycles = 3_000
  let activeRegistrations = 0
  let activeSubscriptions = 0
  let disposedRegistrations = 0
  let closedSubscriptions = 0

  function context(): PluginContext {
    const registration = async () => {
      activeRegistrations++
      return {
        dispose() {
          activeRegistrations--
          disposedRegistrations++
        },
      }
    }
    return {
      model: {
        async list() {
          return { data: [] }
        },
      },
      session: {
        async get() {
          return {}
        },
        async switchModel() {},
        async synthetic() {
          return {}
        },
        hook: registration,
      },
      event: {
        subscribe({ signal }) {
          activeSubscriptions++
          return (async function* () {
            try {
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve()
                else signal.addEventListener("abort", () => resolve(), { once: true })
              })
            } finally {
              activeSubscriptions--
              closedSubscriptions++
            }
          })()
        },
      },
      rpc: {
        register: registration,
      },
    }
  }

  const restore = console.error
  console.error = () => {}
  try {
    for (let cycle = 0; cycle < 200; cycle++) {
      setupModelAutoRouter(context(), {})()
    }
    await new Promise((resolve) => setImmediate(resolve))
    gc!()
    gc!()
    const baseline = process.memoryUsage().heapUsed

    for (let cycle = 0; cycle < cycles; cycle++) {
      setupModelAutoRouter(context(), {})()
      if (cycle % 100 === 0) await new Promise((resolve) => setImmediate(resolve))
    }
    await new Promise((resolve) => setImmediate(resolve))
    gc!()
    gc!()
    const retained = process.memoryUsage().heapUsed - baseline

    assert.equal(activeRegistrations, 0)
    assert.equal(activeSubscriptions, 0)
    assert.equal(disposedRegistrations, (cycles + 200) * 5)
    assert.equal(closedSubscriptions, cycles + 200)
    assert.ok(
      retained < 16 * 1024 * 1024,
      `retained heap grew by ${retained} bytes after ${cycles} cycles`,
    )
    console.log(JSON.stringify({ cycles, closedSubscriptions, disposedRegistrations, retainedHeapBytes: retained }))
  } finally {
    console.error = restore
  }
})
