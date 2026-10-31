// @ts-check
import { disableWrite, transition } from "./core.js"

/** One controller per window. Operations are per session and serialized. */
export function createAutonomyController(api, notify = () => {}) {
  let sessionID
  let generation = 0
  let queue = Promise.resolve()
  let state = { status: "off", acknowledged: false }

  const publish = () => notify(sessionID ? { ...state } : { status: "off", acknowledged: false })
  const select = (id) => {
    if (typeof id !== "string" || !/^ses_[A-Za-z0-9_-]{1,256}$/.test(id)) id = undefined
    if (id === sessionID) return
    sessionID = id
    generation++
    state = { status: "off", acknowledged: false }
    queue = Promise.resolve()
    publish()
  }
  const operation = (callback) => {
    const ownGeneration = generation
    const ownSession = sessionID
    const run = async () => {
      if (ownGeneration !== generation || ownSession !== sessionID) return { ok: false, reason: "stale" }
      return callback()
    }
    queue = queue.then(run, run)
    return queue
  }

  return {
    select,
    snapshot: () => ({ sessionID, generation, state: { ...state } }),
    async refresh() {
      if (!sessionID) return publish()
      return operation(async () => {
        const ownSession = sessionID
        try {
          const rules = await api.read(ownSession)
          if (ownSession !== sessionID) return
          state = {
            ...state,
            status: rules.some((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")
              ? "on"
              : "off",
          }
        } catch {
          if (ownSession === sessionID) state = { ...state, status: "error" }
        } finally {
          if (ownSession === sessionID) publish()
        }
      })
    },
    async enable(acknowledged) {
      if (!sessionID) return { ok: false, reason: "unavailable" }
      return operation(async () => {
        const ownSession = sessionID
        const ownGeneration = generation
        const requested = transition(state, { type: "request-enable", acknowledged }, ownGeneration)
        if (!requested.accepted) return { ok: false, reason: "confirmation" }
        state = requested.state
        publish()
        try {
          const rules = await api.read(ownSession)
          const loaded = transition(state, { type: "loaded", generation: ownGeneration, rules }, ownGeneration)
          if (!loaded.accepted) return { ok: false, reason: "stale" }
          state = loaded.state
          if (!loaded.write) return { ok: true }
          const applied = await api.update(ownSession, loaded.write)
          const current = await api.read(ownSession)
          if (!same(current, applied)) throw new Error("Permission verification failed")
          const written = transition(
            state,
            { type: "written", generation: ownGeneration, rules: current },
            ownGeneration,
          )
          state = written.state
          if (!written.accepted) return { ok: false, reason: "conflict" }
          return { ok: true }
        } catch {
          state = transition(state, { type: "failed", generation: ownGeneration }, ownGeneration).state
          publish()
          return { ok: false, reason: "error" }
        }
      })
    },
    async disable() {
      if (!sessionID) return { ok: false, reason: "unavailable" }
      return operation(async () => {
        const ownSession = sessionID
        const ownGeneration = generation
        const requested = transition(state, { type: "request-disable" }, ownGeneration)
        if (!requested.accepted) return { ok: false, reason: "busy" }
        state = requested.state
        publish()
        try {
          const current = await api.read(ownSession)
          const decision = disableWrite(current, state.baseline)
          if (decision.kind === "conflict") {
            state = { ...state, status: "off", baseline: undefined, expected: undefined }
            publish()
            return { ok: false, reason: "conflict" }
          }
          const applied = await api.update(ownSession, decision.rules)
          const verified = await api.read(ownSession)
          if (!same(verified, applied)) throw new Error("Permission verification failed")
          state = { status: "off", acknowledged: false }
          return { ok: true }
        } catch {
          state = { ...state, status: "error", expected: undefined }
          publish()
          return { ok: false, reason: "error" }
        }
      })
    },
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}
