import assert from "node:assert/strict"
import test from "node:test"
import { createAutonomyController } from "../controller.cjs"

const ID = "ses_test"
const OTHER = "ses_other"
const OFF = { enabled: false, status: "off" }
const ON = { enabled: true, status: "on" }
const tick = () => new Promise((resolve) => setImmediate(resolve))
const clone = (value) => ({ ...value })

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)))
  return { promise, resolve, reject }
}

function fixture(initial = {}) {
  const states = new Map(Object.entries(initial))
  const calls = []
  let active = 0
  let maximum = 0
  const read = (id) => (states.has(id) ? clone(states.get(id)) : clone(OFF))
  const api = {
    async state(id) {
      calls.push(["state", id])
      active++
      maximum = Math.max(maximum, active)
      await tick()
      active--
      return read(id)
    },
    async enable(id) {
      calls.push(["enable", id])
      active++
      maximum = Math.max(maximum, active)
      await tick()
      active--
      states.set(id, clone(ON))
      return clone(ON)
    },
    async disable(id) {
      calls.push(["disable", id])
      active++
      maximum = Math.max(maximum, active)
      await tick()
      active--
      states.set(id, clone(OFF))
      return clone(OFF)
    },
  }
  return { api, calls, states, read, get maximum() { return maximum }, get active() { return active } }
}

test("enable requires explicit confirmation and a session", async () => {
  const env = fixture()
  const controller = createAutonomyController(env.api)
  assert.equal((await controller.enable(true)).reason, "unavailable")
  assert.equal((await controller.refresh()).ok, true)
  controller.select(ID)
  assert.equal((await controller.enable(false)).reason, "confirmation")
  assert.equal(env.calls.length, 0)
  assert.equal(controller.snapshot().state.enabled, false)
  assert.deepEqual(await controller.enable(true), { ok: true })
  assert.equal(controller.snapshot().state.status, "on")
  assert.deepEqual(env.calls, [["enable", ID]])
  assert.deepEqual(await controller.disable(), { ok: true })
  assert.deepEqual(env.calls, [["enable", ID], ["disable", ID]])
  assert.deepEqual(controller.snapshot().state, { enabled: false, status: "off" })
})

test("already enabled sessions do not call the bridge again", async () => {
  const env = fixture({ [ID]: ON })
  const controller = createAutonomyController(env.api)
  controller.select(ID)
  await controller.refresh()
  assert.deepEqual(await controller.enable(true), { ok: true, already: true })
  assert.deepEqual(env.calls, [["state", ID]])
})

test("refresh mirrors the main process and preserves enabled on read failure", async () => {
  const env = fixture({ [ID]: OFF })
  const controller = createAutonomyController(env.api)
  controller.select(ID)
  await controller.refresh()
  assert.equal(controller.snapshot().state.status, "off")

  env.states.set(ID, clone(ON))
  await controller.refresh()
  assert.deepEqual(controller.snapshot().state, ON)

  env.states.set(ID, { enabled: true, status: "error" })
  await controller.refresh()
  assert.deepEqual(controller.snapshot().state, { enabled: true, status: "error" })

  env.api.state = async () => {
    throw new Error("PRIVATE_STATE")
  }
  assert.equal((await controller.refresh()).reason, "error")
  assert.deepEqual(controller.snapshot().state, { enabled: true, status: "error" })
})

test("failed enable and failed disable stay retryable", async () => {
  const env = fixture()
  const controller = createAutonomyController(env.api)
  controller.select(ID)

  env.api.enable = async () => {
    throw Object.assign(new Error("PRIVATE_ENABLE"), { reason: "unavailable" })
  }
  assert.deepEqual(await controller.enable(true), { ok: false, reason: "unavailable" })
  assert.deepEqual(controller.snapshot().state, { enabled: false, status: "error" })

  env.api.enable = async () => clone(ON)
  assert.deepEqual(await controller.enable(true), { ok: true })
  assert.deepEqual(controller.snapshot().state, ON)

  env.api.disable = async () => {
    throw Object.assign(new Error("PRIVATE_DISABLE"), { reason: "error" })
  }
  assert.deepEqual(await controller.disable(), { ok: false, reason: "error" })
  assert.deepEqual(controller.snapshot().state, { enabled: true, status: "error" })

  env.api.disable = async () => clone(OFF)
  assert.deepEqual(await controller.disable(), { ok: true })
  assert.deepEqual(controller.snapshot().state, OFF)
})

test("enabled error state can still be disabled", async () => {
  const env = fixture({ [ID]: { enabled: true, status: "error" } })
  const controller = createAutonomyController(env.api)
  controller.select(ID)
  await controller.refresh()
  assert.equal(controller.snapshot().state.enabled, true)
  assert.deepEqual(await controller.disable(), { ok: true })
  assert.deepEqual(controller.snapshot().state, OFF)
})

test("session switches isolate state and late results cannot revive an old session", async () => {
  const env = fixture()
  const pending = deferred()
  env.api.enable = async (id) => {
    env.calls.push(["enable", id])
    return pending.promise
  }
  const controller = createAutonomyController(env.api)
  controller.select(ID)
  const enabling = controller.enable(true)
  await tick()
  controller.select(OTHER)
  pending.resolve(ON)
  assert.deepEqual(await enabling, { ok: false, reason: "stale" })
  assert.equal(controller.snapshot().sessionID, OTHER)
  assert.deepEqual(controller.snapshot().state, OFF)
})

test("A to B to A cannot revive a stale refresh", async () => {
  const env = fixture({ [ID]: ON })
  const pending = deferred()
  let first = true
  env.api.state = async (id) => {
    env.calls.push(["state", id])
    if (id === ID && first) {
      first = false
      return pending.promise
    }
    return clone(env.read(id))
  }
  const controller = createAutonomyController(env.api)
  controller.select(ID)
  const refresh = controller.refresh()
  await tick()
  controller.select(OTHER)
  controller.select(ID)
  pending.resolve(ON)
  assert.deepEqual(await refresh, { ok: false, reason: "stale" })
  assert.deepEqual(controller.snapshot().state, OFF)
  await controller.refresh()
  assert.deepEqual(controller.snapshot().state, ON)
})

test("invalid session IDs are rejected without clearing a valid selection", () => {
  const env = fixture()
  const controller = createAutonomyController(env.api)
  controller.select("ses_тест")
  assert.equal(controller.snapshot().sessionID, undefined)
  controller.select(ID)
  controller.select("PRIVATE")
  assert.equal(controller.snapshot().sessionID, undefined)
  assert.deepEqual(controller.snapshot().state, OFF)
})

test("publishes every successful transition and never publishes an ID", () => {
  const env = fixture()
  const states = []
  const controller = createAutonomyController(env.api, (value) => states.push(value))
  controller.select(ID)
  assert.deepEqual(states, [OFF])
  assert.ok(states.every((value) => !("sessionID" in value)))
})

test("2,000 queued toggles are serialized and end in the last requested state", { timeout: 60_000 }, async () => {
  const env = fixture()
  const controller = createAutonomyController(env.api)
  controller.select(ID)
  const operations = []
  for (let index = 0; index < 2_000; index++) {
    operations.push(index % 2 === 0 ? controller.enable(true) : controller.disable())
  }
  await Promise.all(operations)
  assert.equal(env.maximum, 1)
  assert.equal(env.active, 0)
  assert.deepEqual(controller.snapshot().state, OFF)
  assert.equal(env.calls.length, 2_000)
})

test("5,000 session changes during failures do not leak state", { timeout: 60_000 }, async () => {
  let active = 0
  let maximum = 0
  const api = {
    async state(id) {
      active++
      maximum = Math.max(maximum, active)
      await tick()
      active--
      if (Number(id.slice(4)) % 7 === 0) throw new Error("PRIVATE")
      return Number(id.slice(4)) % 2 === 0 ? clone(ON) : clone(OFF)
    },
    async enable() {
      await tick()
      return clone(ON)
    },
    async disable() {
      await tick()
      return clone(OFF)
    },
  }
  const controller = createAutonomyController(api)
  for (let index = 0; index < 5_000; index++) {
    const id = `ses_${index}`
    controller.select(id)
    const operation = controller.refresh()
    if (index % 2 === 0) controller.select(`ses_${index + 1}`)
    await operation
  }
  assert.equal(active, 0)
  assert.ok(maximum <= 1)
  assert.equal(controller.snapshot().state.enabled, false)
})
