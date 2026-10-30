import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

// The desktop host supplies these modules to the CommonJS GUI bundle. Node's
// package exports expose them as ESM, so reproduce that host boundary here.
const modules: Record<string, unknown> = {
  "solid-js": await import("solid-js"),
  "solid-js/web": {
    template: () => () => ({}),
    delegateEvents: () => {},
  },
  "@opencode/plugin/gui": await import("@opencode/plugin/gui"),
  "@opencode/plugin/rpc": await import("@opencode/plugin/rpc"),
}
const code = await readFile(new URL("../dist/gui-experimental.cjs", import.meta.url), "utf8")
interface HostModule {
  exports: { default?: { setup?: (ctx: unknown) => void } }
}
const hostModule: HostModule = { exports: {} }
const evaluate = new Function("require", "module", "exports", code) as (
  require: (id: string) => unknown,
  module: HostModule,
  exports: unknown,
) => void
evaluate(
  (id) => {
    if (!(id in modules)) throw new Error(`Unexpected GUI dependency: ${id}`)
    return modules[id]
  },
  hostModule,
  hostModule.exports,
)

const definition = hostModule.exports.default
assert.equal(typeof definition?.setup, "function")

const contributions: unknown[] = []
definition!.setup!({
  id: "opecode-model-autorouter",
  add(_registry: unknown, item: unknown) {
    contributions.push(item)
    return () => {}
  },
})

const page = contributions.find(
  (item): item is { id: string; title: string; render: unknown } =>
    typeof item === "object" &&
    item !== null &&
    "title" in item &&
    item.title === "Model Autorouter",
)
assert.equal(page?.id, "opecode-model-autorouter")
assert.equal(typeof page?.render, "function")
assert.ok(
  contributions.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "id" in item &&
      item.id === "open" &&
      "run" in item &&
      typeof item.run === "function",
  ),
)
assert.ok(contributions.some((item) => typeof item === "string" && item.includes(".mar-page")))

console.log(JSON.stringify({ gui: "gui-experimental", settingsPage: page.id, command: "open" }))
