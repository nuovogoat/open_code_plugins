import assert from "node:assert/strict"
import test from "node:test"
import {
  initialState,
  isBusy,
  normalizeReason,
  normalizeState,
  transition,
  validSessionID,
} from "../core.cjs"

test("session IDs are strict ASCII identifiers", () => {
  assert.equal(validSessionID("ses_a"), true)
  assert.equal(validSessionID("ses_A-1_2"), true)
  assert.equal(validSessionID("ses_" + "a".repeat(256)), true)
  assert.equal(validSessionID("ses_" + "a".repeat(257)), false)
  assert.equal(validSessionID("ses_"), false)
  assert.equal(validSessionID("ses_a\n"), false)
  assert.equal(validSessionID("ses_a\0"), false)
  assert.equal(validSessionID("ses_a/b"), false)
  assert.equal(validSessionID("ses_a b"), false)
  assert.equal(validSessionID("ses_тест"), false)
  for (const value of [undefined, null, 1, {}, [], true]) assert.equal(validSessionID(value), false)
})

test("completed state is normalized strictly and copied", () => {
  const input = { enabled: true, status: "on" }
  const output = normalizeState(input)
  assert.deepEqual(output, input)
  assert.notEqual(output, input)
  output.enabled = false
  assert.equal(input.enabled, true)
  assert.deepEqual(normalizeState({ enabled: false, status: "off" }), { enabled: false, status: "off" })
  assert.deepEqual(normalizeState({ enabled: false, status: "error" }), { enabled: false, status: "error" })
  assert.deepEqual(normalizeState({ enabled: true, status: "error" }), { enabled: true, status: "error" })
  for (const value of [
    null,
    [],
    "on",
    {},
    { enabled: "true", status: "on" },
    { enabled: true, status: "enabling" },
    { enabled: true, status: "off" },
    { enabled: false, status: "on" },
    { enabled: true, status: "on", extra: true },
  ]) {
    assert.throws(() => normalizeState(value))
  }
})

test("reasons are allowlisted", () => {
  assert.equal(normalizeReason("unavailable"), "unavailable")
  assert.equal(normalizeReason("not_found"), "not_found")
  assert.equal(normalizeReason("PRIVATE"), "error")
  assert.equal(normalizeReason(undefined), "error")
})

test("confirmation is mandatory and state transitions are ordered", () => {
  const off = initialState()
  assert.equal(off.enabled, false)
  assert.equal(isBusy(off), false)
  assert.equal(transition(off, { type: "request-enable", acknowledged: false }).accepted, false)
  const enabling = transition(off, { type: "request-enable", acknowledged: true })
  assert.deepEqual(enabling.state, { enabled: false, status: "enabling" })
  assert.equal(isBusy(enabling.state), true)
  assert.equal(transition(enabling.state, { type: "request-disable" }).accepted, false)
  assert.equal(transition(enabling.state, { type: "refresh", state: { enabled: true, status: "on" } }).accepted, false)

  const on = transition(enabling.state, { type: "result", state: { enabled: true, status: "on" } })
  assert.deepEqual(on.state, { enabled: true, status: "on" })

  const disabling = transition(on.state, { type: "request-disable" })
  assert.deepEqual(disabling.state, { enabled: true, status: "disabling" })
  const disabled = transition(disabling.state, { type: "result", state: { enabled: false, status: "off" } })
  assert.deepEqual(disabled.state, { enabled: false, status: "off" })

  const enableFailed = transition(enabling.state, { type: "result", error: true })
  assert.deepEqual(enableFailed.state, { enabled: false, status: "error" })
  const disableFailed = transition(disabling.state, { type: "result", error: true })
  assert.deepEqual(disableFailed.state, { enabled: true, status: "error" })
})

test("busy transitions reject stale results and refresh cannot erase an enable", () => {
  const on = { enabled: true, status: "on" }
  assert.equal(transition(on, { type: "result", state: { enabled: true, status: "on" } }).accepted, false)
  const error = transition(on, { type: "refresh", state: { enabled: true, status: "error" } })
  assert.deepEqual(error.state, { enabled: true, status: "error" })
  assert.equal(transition(on, { type: "unknown" }).accepted, false)
})

test("every Unicode code point and control character is classified correctly in a session ID", () => {
  for (let point = 0; point <= 0x10ffff; point++) {
    const symbol = String.fromCodePoint(point)
    const valid = /^[A-Za-z0-9_-]$/.test(symbol)
    assert.equal(validSessionID(`ses_a${symbol}`), valid, `U+${point.toString(16)}`)
  }
  assert.equal(validSessionID("ses_a\u200b"), false)
  assert.equal(validSessionID("ses_a\u202e"), false)
  assert.equal(validSessionID("ses_a\ud800"), false)
  assert.equal(validSessionID("ses_a\t"), false)
})
