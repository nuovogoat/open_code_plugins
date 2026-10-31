import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import plugin from "../index.ts"

// Run with node_modules installed: this loads the actual SDK selected by the manifest.
assert.equal(plugin.id, "opencode-model-autorouter")
assert.equal(typeof plugin.setup, "function")

const hooks = new Map<string, (event: any) => void | Promise<void>>()
const rpcHandlers: Record<string, (input: any) => Promise<any>> = {}
let current = { providerID: "sdk-a", id: "same" }
let disposed = 0
const registration = async () => ({
  dispose() {
    disposed++
  },
})
const models = ["sdk-a", "sdk-b"].map((providerID) => ({
  providerID,
  id: "same",
  name: "Same",
  type: "chat",
  enabled: true,
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  limit: { context: 200_000, output: 8_000 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
}))

const cleanup = await plugin.setup({
  options: { rescanIntervalMs: 60_000 },
  model: {
    list() {
      return { data: models }
    },
  },
  session: {
    async get() {
      return { model: current }
    },
    async switchModel(input: { model: typeof current }) {
      current = input.model
    },
    async synthetic() {
      return {}
    },
    async hook(kind: string, callback: (event: any) => void | Promise<void>) {
      hooks.set(kind, callback)
      return registration()
    },
  },
  event: {
    subscribe({ signal }: { signal: AbortSignal }) {
      return (async function* () {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener("abort", () => resolve(), { once: true })
        })
      })()
    },
  },
  rpc: {
    async register(definition: { id?: string }, handlers: Record<string, (input: any) => Promise<any>>) {
      assert.equal(definition.id, "opencode-model-autorouter")
      Object.assign(rpcHandlers, handlers)
      return registration()
    },
  },
} as never)
if (typeof cleanup !== "function") throw new Error("plugin setup returned no cleanup")

try {
  const deadline = Date.now() + 1_000
  while ((hooks.size < 4 || !rpcHandlers.rescan) && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.deepEqual([...hooks.keys()].sort(), ["http.response", "model.request", "prompt", "retry"])
  const status = await rpcHandlers.rescan({})
  assert.equal(status.modelsDiscovered, 2)
  assert.equal(status.models.length, 2)
  assert.equal("defaultGroup" in status, false)
  assert.equal(status.groups[0].name, "auto:same")
  assert.equal(status.groups[0].candidates.length, 2)
  assert.equal(JSON.stringify(status).includes("C:\\"), false)
} finally {
  cleanup()
}
await new Promise((resolve) => setImmediate(resolve))
assert.equal(disposed, 5)

const manifest = JSON.parse(
  await readFile(new URL("../node_modules/@opencode/plugin/package.json", import.meta.url), "utf8"),
)
console.log(JSON.stringify({ sdk: manifest.version, plugin: plugin.id, status: "ok" }))
