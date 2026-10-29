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

  const tag = `project-folder-tabs/v${version}`
  const pinned = `#${tag}::path:project-folder-tabs`
  const [root, plugin, changelog] = await Promise.all([
    text("../../README.md"),
    text("../README.md"),
    text("../CHANGELOG.md"),
  ])

  assert.ok(root.includes(`| [project-folder-tabs](project-folder-tabs/) | ${version} |`))
  assert.ok(root.includes(pinned))
  assert.ok(plugin.includes(pinned))
  assert.ok(changelog.includes(`## [${version}]`))
})
