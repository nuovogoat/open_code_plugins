// @ts-check
"use strict"

const { initialState, isBusy, normalizeReason, transition, validSessionID } = require("./core.cjs")

/** One controller per window. Operations are per session and serialized. */
function createAutonomyController(api, notify = () => {}) {
  let sessionID
  let generation = 0
  let queue = Promise.resolve()
  let state = initialState()

  function publish() {
    try {
      notify(sessionID ? { ...state } : initialState())
    } catch {
      // Rendering must never be able to break a state transition.
    }
  }

  function select(id) {
    if (!validSessionID(id)) id = undefined
    if (id === sessionID) return false
    sessionID = id
    generation++
    state = initialState()
    publish()
    return true
  }

  function operation(callback) {
    const ownGeneration = generation
    const ownSession = sessionID
    const current = () => ownGeneration === generation && ownSession === sessionID
    const run = async () => {
      if (!current()) return { ok: false, reason: "stale" }
      try {
        return await callback(current, ownSession)
      } catch {
        return { ok: false, reason: "error" }
      }
    }
    queue = queue.then(run, run)
    return queue
  }

  function apply(event) {
    const next = transition(state, event)
    if (!next.accepted) return false
    state = next.state
    publish()
    return true
  }

  return {
    select,
    snapshot: () => ({ sessionID, generation, state: { ...state } }),

    async refresh() {
      if (!sessionID) {
        publish()
        return { ok: true }
      }
      return operation(async (current, ownSession) => {
        if (isBusy(state)) return { ok: false, reason: "busy" }
        try {
          const result = await api.state(ownSession)
          if (!current()) return { ok: false, reason: "stale" }
          apply({ type: "refresh", state: result })
          return { ok: true }
        } catch {
          if (!current()) return { ok: false, reason: "stale" }
          apply({ type: "refresh", state: { enabled: state.enabled, status: "error" } })
          return { ok: false, reason: "error" }
        }
      })
    },

    async enable(acknowledged) {
      if (!sessionID) return { ok: false, reason: "unavailable" }
      return operation(async (current, ownSession) => {
        if (state.enabled) return { ok: true, already: true }
        if (isBusy(state)) return { ok: false, reason: "busy" }
        if (acknowledged !== true) return { ok: false, reason: "confirmation" }
        if (!apply({ type: "request-enable", acknowledged: true })) {
          return { ok: false, reason: "confirmation" }
        }
        try {
          const result = await api.enable(ownSession)
          if (!current()) return { ok: false, reason: "stale" }
          if (!apply({ type: "result", state: result })) throw new Error("Invalid transition")
          if (!state.enabled) return { ok: false, reason: "error" }
          return { ok: true, ...(result.already === true ? { already: true } : {}) }
        } catch (error) {
          if (!current()) return { ok: false, reason: "stale" }
          apply({ type: "result", error: true })
          return { ok: false, reason: normalizeReason(error?.reason) }
        }
      })
    },

    async disable() {
      if (!sessionID) return { ok: false, reason: "unavailable" }
      return operation(async (current, ownSession) => {
        if (isBusy(state)) return { ok: false, reason: "busy" }
        if (!apply({ type: "request-disable" })) return { ok: false, reason: "busy" }
        try {
          const result = await api.disable(ownSession)
          if (!current()) return { ok: false, reason: "stale" }
          if (!apply({ type: "result", state: result })) throw new Error("Invalid transition")
          if (state.enabled) return { ok: false, reason: "error" }
          return { ok: true }
        } catch (error) {
          if (!current()) return { ok: false, reason: "stale" }
          apply({ type: "result", error: true })
          return { ok: false, reason: normalizeReason(error?.reason) }
        }
      })
    },
  }
}

module.exports = { createAutonomyController }
