import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

async function text(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8")
}

test("version: manifest, changelog and pinned installation docs stay in sync", async () => {
  const manifest = JSON.parse(await text("../package.json"))
  const version = manifest.version
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u)

  const pinned = `#opecode-model-autorouter/v${version}::path:opecode-model-autorouter`
  const [root, plugin, changelog] = await Promise.all([
    text("../../README.md"),
    text("../README.md"),
    text("../CHANGELOG.md"),
  ])

  assert.ok(root.includes(`| [opecode-model-autorouter](opecode-model-autorouter/) | ${version} |`))
  assert.ok(root.includes(pinned))
  assert.ok(plugin.includes(pinned))
  assert.ok(changelog.includes(`## [${version}]`))
})
