import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

// Регрессионный гейт (стандарт §8.2, §10): каждый пункт REGRESSIONS.md описывает
// инцидент и ссылается на реально существующий тест. Пункты нельзя тихо удалять.
test("regressions gate: every REGRESSIONS.md entry references real tests", async () => {
  const text = await readFile(new URL("../REGRESSIONS.md", import.meta.url), "utf8")
  const entries = text.split(/^## /mu).slice(1)
  assert.ok(
    entries.length >= 8,
    `REGRESSIONS.md lost entries (found ${entries.length}, expected at least 8) — deletions must be deliberate`,
  )
  const seenIDs = new Set<string>()
  for (const entry of entries) {
    const id = entry.match(/^R-\d+/u)?.[0]
    assert.ok(id, `entry without an R-NNN identifier: ${entry.slice(0, 60)}`)
    assert.equal(seenIDs.has(id!), false, `duplicate entry ${id}`)
    seenIDs.add(id!)
    assert.match(entry, /- Инцидент:/u, `${id}: missing the incident description`)
    assert.match(entry, /- Версии:/u, `${id}: missing the version trail`)
    const refs = [...entry.matchAll(/^- Тест: `([^`]+)` — «([^»]+)»$/gmu)]
    assert.ok(refs.length > 0, `${id}: no test reference in the required format`)
    for (const [, file, name] of refs) {
      assert.match(file, /^test\/[^\s]+\.ts$/u, `${id}: reference must point into test/`)
      const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8")
      assert.ok(
        source.includes(`test("${name}"`),
        `${id}: test «${name}» does not exist in ${file}`,
      )
    }
  }
})
