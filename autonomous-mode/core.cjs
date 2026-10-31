// @ts-check
"use strict"

const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,256}$/
const STATUSES = Object.freeze(["off", "on", "error"])
const REASONS = Object.freeze(["confirmation", "invalid", "not_found", "unavailable", "error"])

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validSessionID(value) {
  return typeof value === "string" && SESSION_ID.test(value)
}

/** Accepts only a completed, internally consistent state from the main process. */
function normalizeState(value) {
  if (!isRecord(value)) throw new Error("Invalid autonomy state")
  if (Object.keys(value).some((key) => key !== "enabled" && key !== "status")) {
    throw new Error("Invalid autonomy state")
  }
  if (typeof value.enabled !== "boolean" || !STATUSES.includes(value.status)) {
    throw new Error("Invalid autonomy state")
  }
  if (value.status === "off" ? value.enabled : value.status === "on" && !value.enabled) {
    throw new Error("Invalid autonomy state")
  }
  return { enabled: value.enabled, status: value.status }
}

function initialState() {
  return { enabled: false, status: "off" }
}

function isBusy(state) {
  return state.status === "enabling" || state.status === "disabling"
}

function normalizeReason(value) {
  return typeof value === "string" && REASONS.includes(value) ? value : "error"
}

/** Pure UI-state transitions. A generation check lives in the controller. */
function transition(state, event) {
  switch (event?.type) {
    case "request-enable":
      if (event.acknowledged !== true || isBusy(state) || state.enabled) {
        return { accepted: false, state }
      }
      return { accepted: true, state: { enabled: false, status: "enabling" } }
    case "request-disable":
      if (isBusy(state)) return { accepted: false, state }
      return { accepted: true, state: { ...state, status: "disabling" } }
    case "result": {
      if (event.error) {
        if (state.status === "enabling") {
          return { accepted: true, state: { enabled: false, status: "error" } }
        }
        if (state.status === "disabling") {
          return { accepted: true, state: { enabled: state.enabled, status: "error" } }
        }
        return { accepted: false, state }
      }
      const next = normalizeState(event.state)
      if (state.status === "enabling") {
        return { accepted: true, state: next.enabled ? next : { enabled: false, status: "error" } }
      }
      if (state.status === "disabling") {
        return { accepted: true, state: next.enabled ? { enabled: true, status: "error" } : { enabled: false, status: "off" } }
      }
      return { accepted: false, state }
    }
    case "refresh": {
      if (isBusy(state)) return { accepted: false, state }
      return { accepted: true, state: normalizeState(event.state) }
    }
    default:
      return { accepted: false, state }
  }
}

module.exports = {
  SESSION_ID,
  STATUSES,
  isRecord,
  validSessionID,
  normalizeState,
  initialState,
  isBusy,
  normalizeReason,
  transition,
}
