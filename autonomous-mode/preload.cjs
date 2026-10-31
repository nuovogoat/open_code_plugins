// Injected only by the reviewed Desktop adapter. Never receives server credentials.
"use strict"

const { ipcRenderer } = require("electron")
const { normalizeReason, normalizeState } = require("./core.cjs")
const { mountAutonomyUI } = require("./ui.cjs")
const { mountModelMenuUI } = require("./model-menu.cjs")

class AutonomyError extends Error {
  constructor(reason) {
    super("Autonomy request failed")
    this.reason = normalizeReason(reason)
  }
}

function decode(result) {
  if (!result || result.ok !== true) throw new AutonomyError(result?.reason)
  const state = normalizeState({ enabled: result.enabled, status: result.status })
  if ("already" in result && typeof result.already !== "boolean") throw new AutonomyError("error")
  return {
    enabled: state.enabled,
    status: state.status,
    ...(result.already === true ? { already: true } : {}),
  }
}

async function invoke(channel, ...args) {
  try {
    return decode(await ipcRenderer.invoke(channel, ...args))
  } catch (error) {
    if (error instanceof AutonomyError) throw error
    throw new AutonomyError("error")
  }
}

const api = {
  state(sessionID) {
    return invoke("autonomous-mode:state", sessionID)
  },
  enable(sessionID) {
    return invoke("autonomous-mode:enable", sessionID, true)
  },
  disable(sessionID) {
    return invoke("autonomous-mode:disable", sessionID)
  },
}

function start() {
  try {
    mountModelMenuUI({ window, document })
  } catch {
    // Model-menu enhancements are optional and must not affect the Desktop window.
  }
  if (document.getElementById("autonomous-mode-toggle")) return
  try {
    mountAutonomyUI({
      window,
      document,
      ...api,
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
    })
  } catch {
    // A UI failure must never prevent the Desktop window from working.
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true })
else start()
