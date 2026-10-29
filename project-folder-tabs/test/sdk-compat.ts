import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import plugin from "../index.ts"

// Run after `npm install`: this checks the actual SDK selected by the manifest,
// rather than a copied declaration or a product-version-specific shim.
assert.equal(plugin.id, "project-folder-tabs")
assert.equal(typeof plugin.setup, "function")

let titleHook: ((event: { result?: string }) => void) | undefined
let disposed = 0
const updates: Array<{ sessionID: string; title: string }> = []
const cleanup = await plugin.setup({
  location: {
    directory: "C:\\sdk\\checkout",
    project: {
      id: "sdk",
      directory: "C:\\sdk\\checkout",
      canonical: "C:\\sdk\\current",
    },
  },
  session: {
    async hook(kind: "title", callback: (event: { result?: string }) => void) {
      assert.equal(kind, "title")
      titleHook = callback
      return {
        async dispose() {
          disposed++
        },
      }
    },
    async list() {
      return { data: [{ id: "ses_sdk", title: "old" }] }
    },
    async update(input: { sessionID: string; title: string }) {
      updates.push(input)
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
} as never)

await new Promise((resolve) => setImmediate(resolve))
assert.ok(titleHook)
const event: { result?: string } = {}
titleHook(event)
assert.equal(event.result, "current")
assert.deepEqual(updates, [{ sessionID: "ses_sdk", title: "current" }])
cleanup()
await new Promise((resolve) => setImmediate(resolve))
assert.equal(disposed, 1)

const manifest = JSON.parse(
  await readFile(new URL("../node_modules/@opencode/plugin/package.json", import.meta.url), "utf8"),
)
console.log(JSON.stringify({ sdk: manifest.version, plugin: plugin.id, status: "ok" }))
