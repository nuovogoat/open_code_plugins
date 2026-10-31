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

  const pinned = `#opencode-model-autorouter/v${version}::path:opencode-model-autorouter`
  const [root, plugin, changelog] = await Promise.all([
    text("../../README.md"),
    text("../README.md"),
    text("../CHANGELOG.md"),
  ])

  assert.ok(root.includes(`| [opencode-model-autorouter](opencode-model-autorouter/) | ${version} |`))
  assert.ok(root.includes(pinned))
  assert.ok(plugin.includes(pinned))
  assert.ok(changelog.includes(`## [${version}]`))
})

test("gui: bundle carries about-attribution and the single-source version", async () => {
  // §10/§6.11 + DECISIONS.md D-001: attribution and version are rendered inside
  // the embedded panel; the version's single source is package.json (vite define).
  const manifest = JSON.parse(await text("../package.json"))
  const bundle = await text("../dist/gui-experimental.cjs")
  assert.ok(bundle.includes("by nuovogoat"), "bundle lacks the by nuovogoat attribution")
  assert.ok(bundle.includes(manifest.version), "bundle lacks the current product version — rebuild dist")
  const gui = await text("../src/gui.tsx")
  assert.ok(gui.includes("__PLUGIN_VERSION__"), "gui.tsx must render the injected version placeholder")
  assert.equal(gui.includes(`"${manifest.version}"`), false, "gui.tsx duplicates the version literal")
  assert.ok(gui.includes("Справка"), "gui.tsx lacks the help section")
})

test("name: every identifier uses the canonical product spelling", async () => {
  // Gate against the historical «opecode» typo: identifiers are checked
  // against a pinned canonical literal, not against each other.
  const canonical = "opencode-model-autorouter"
  const typo = "opecode"
  const manifest = JSON.parse(await text("../package.json"))
  assert.equal(manifest.name, canonical)
  const sources = [
    "../index.ts",
    "../rpc.ts",
    "../core.ts",
    "../vault.ts",
    "../README.md",
    "../CHANGELOG.md",
    "../../README.md",
    "../../.github/workflows/test.yml",
  ]
  for (const path of sources) {
    const content = await text(path)
    assert.ok(content.includes(canonical), `${path} lacks the canonical name`)
    // The changelog documents the rename, so the old spelling may live there
    // as history; everywhere else the typo is a defect.
    if (!path.endsWith("CHANGELOG.md")) {
      assert.equal(content.includes(typo), false, `${path} still contains the typo`)
    }
  }
})
