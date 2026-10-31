import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

// Хардкод-гейт (стандарт п. 0.12, §8.2): литералы URL/endpoint'ов и путей с
// буквой диска в исходниках инструмента допускаются только как задокументированные
// пины из hardcode_allowlist.txt. Тесты и фикстуры (test/), генерируемые бандлы
// (dist/) и документация (*.md) вне контура сканирования — по тексту стандарта.
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".ps1"])
const SKIP_DIRS = new Set(["node_modules", "dist", "test", "test-results", ".git"])

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...(await sourceFiles(full)))
      continue
    }
    const dot = entry.name.lastIndexOf(".")
    if (dot !== -1 && SCAN_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) found.push(full)
  }
  return found
}

function literalsIn(text: string): string[] {
  const urls = [...text.matchAll(/https?:\/\/[^\s"'`<>()\[\],;|]+/gu)].map((match) => match[0])
  const drives = [...text.matchAll(/\b[A-Za-z]:[\\/]/gu)].map((match) => match[0])
  return [...urls, ...drives]
}

test("hardcode gate: source literals are confined to the documented allowlist", async () => {
  const raw = await readFile(join(root, "hardcode_allowlist.txt"), "utf8")
  const allowlist: Array<{ file: string; literal: string }> = []
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const parts = trimmed.split("|").map((part) => part.trim())
    assert.equal(parts.length, 3, `allowlist line needs "<file> | <literal> | <reason>": ${trimmed}`)
    assert.ok(parts[2].length > 0, `allowlist entry must carry a reason: ${trimmed}`)
    allowlist.push({ file: parts[0], literal: parts[1] })
  }
  assert.ok(
    allowlist.length > 0,
    "hardcode_allowlist.txt is empty — delete the file instead of keeping it empty",
  )

  const expected = new Map<string, Set<string>>()
  for (const entry of allowlist) {
    const set = expected.get(entry.file) ?? new Set<string>()
    set.add(entry.literal)
    expected.set(entry.file, set)
  }

  const seen = new Map<string, Set<string>>()
  for (const file of await sourceFiles(root)) {
    const rel = relative(root, file).split(sep).join("/")
    const literals = literalsIn(await readFile(file, "utf8"))
    if (literals.length > 0) seen.set(rel, new Set(literals))
  }

  // Каждый литерал в исходниках — пин из списка…
  for (const [file, literals] of seen) {
    for (const literal of literals) {
      assert.ok(
        expected.get(file)?.has(literal),
        `${file}: hardcoded literal ${literal} is not listed in hardcode_allowlist.txt`,
      )
    }
  }
  // …и каждая строка списка ещё жива (список остаётся минимальным).
  for (const [file, literals] of expected) {
    for (const literal of literals) {
      assert.ok(
        seen.get(file)?.has(literal),
        `hardcode_allowlist.txt: stale entry "${file} | ${literal}" — the literal is gone from the source`,
      )
    }
  }
})
