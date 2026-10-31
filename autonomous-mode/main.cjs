// Reviewed Desktop adapter: per-session approval of new pending permission requests.
// It never edits session permissions directly. It replies "always" only to requests owned by the
// selected session or a parent-linked descendant at the same location. No identifiers,
// paths, credentials, prompts or raw errors are logged or returned to the renderer.
"use strict"

const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")

const CHANNELS = Object.freeze({
  state: "autonomous-mode:state",
  enable: "autonomous-mode:enable",
  disable: "autonomous-mode:disable",
})
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,256}$/
const REQUEST_ID = /^per[A-Za-z0-9_-]{1,256}$/
const MAX_PENDING = 1024
const MAX_LOCATION = 4096
const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_ANCESTRY = 16
const MAX_PARENT_CACHE = 1024
const MAX_HANDLED = 1024
const HANDLED_TTL = 30_000
const REQUEST_TIMEOUT = 5000
const POLL_INTERVAL = 100
const SETTLE_MS = 100
const FAILURE_LIMIT = 3

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validSessionID(value) {
  return typeof value === "string" && SESSION_ID.test(value)
}

function validRequestID(value) {
  return typeof value === "string" && REQUEST_ID.test(value)
}

function validLocation(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LOCATION &&
    !/[\0\r\n]/.test(value)
  )
}

function codedError(code) {
  const error = new Error("Autonomy service request failed")
  error.code = code
  return error
}

function serviceConfigPath() {
  const configured = process.env.XDG_STATE_HOME
  const base =
    typeof configured === "string" && configured.trim() !== "" && path.isAbsolute(configured.trim())
      ? configured.trim()
      : path.join(os.homedir(), ".local", "state")
  return path.join(base, "opencode", "service.json")
}

function parseServiceURL(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return undefined
  let url
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:") return undefined
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "::1") return undefined
  if (!url.port) return undefined
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  if (url.username || url.password) return undefined
  if (url.pathname !== "/" && url.pathname !== "") return undefined
  if (url.search || url.hash) return undefined
  return url
}

async function readServiceConfig() {
  const file = serviceConfigPath()
  let text
  try {
    text = await fs.readFile(file, "utf8")
  } catch {
    throw codedError("unavailable")
  }
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) throw codedError("unavailable")
  let config
  try {
    config = JSON.parse(text)
  } catch {
    throw codedError("unavailable")
  }
  if (!isRecord(config)) throw codedError("unavailable")
  const url = parseServiceURL(config.url)
  const password = config.password
  if (!url) throw codedError("unavailable")
  if (
    typeof password !== "string" ||
    password.length < 1 ||
    password.length > 1024 ||
    /[\r\n\0]/.test(password)
  ) {
    throw codedError("unavailable")
  }
  return { url, password }
}

function authorization(config) {
  return "Basic " + Buffer.from(`opencode:${config.password}`, "utf8").toString("base64")
}

function apiURL(config, pathname, query) {
  const url = new URL(config.url.toString())
  url.pathname = pathname
  url.search = ""
  url.hash = ""
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  }
  return url
}

async function readBody(response) {
  const length = response.headers.get("content-length")
  if (length !== null && Number(length) > MAX_REQUEST_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw codedError("unavailable")
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => {})
        throw codedError("unavailable")
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString("utf8")
}

async function request(config, url, options = {}) {
  let response
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        authorization: authorization(config),
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
  } catch {
    throw codedError("unavailable")
  }
  let text
  try {
    text = await readBody(response)
  } catch (error) {
    if (error?.code) throw error
    throw codedError("unavailable")
  }
  if (response.status === 404) throw codedError("not_found")
  if (response.status === 401 || response.status === 403) throw codedError("unavailable")
  if (!response.ok) throw codedError("unavailable")
  return { status: response.status, text }
}

function parseJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    throw codedError("unavailable")
  }
}

function sessionInfoFrom(value, expectedID) {
  if (!isRecord(value) || !isRecord(value.data)) throw codedError("unavailable")
  const data = value.data
  if (data.id !== expectedID) throw codedError("unavailable")
  if (!isRecord(data.location) || !validLocation(data.location.directory)) throw codedError("unavailable")
  let parentID = null
  if (data.parentID !== undefined && data.parentID !== null) {
    if (!validSessionID(data.parentID)) throw codedError("unavailable")
    parentID = data.parentID
  }
  return { id: data.id, parentID, location: data.location.directory }
}

async function readSessionInfo(config, sessionID) {
  if (!validSessionID(sessionID)) throw codedError("invalid")
  const url = apiURL(config, `/api/session/${encodeURIComponent(sessionID)}`)
  const { text } = await request(config, url)
  return sessionInfoFrom(parseJSON(text), sessionID)
}

function pendingFrom(value, directory) {
  if (!isRecord(value) || !isRecord(value.location) || value.location.directory !== directory) {
    throw codedError("unavailable")
  }
  if (!Array.isArray(value.data) || value.data.length > MAX_PENDING) throw codedError("unavailable")
  const pending = []
  for (const item of value.data) {
    if (!isRecord(item) || !validRequestID(item.id) || !validSessionID(item.sessionID)) {
      throw codedError("unavailable")
    }
    pending.push({ id: item.id, sessionID: item.sessionID })
  }
  return pending
}

async function listPending(config, directory) {
  if (!validLocation(directory)) throw codedError("invalid")
  const url = apiURL(config, "/api/permission/request", { "location[directory]": directory })
  const { text } = await request(config, url)
  return pendingFrom(parseJSON(text), directory)
}

async function replyAlways(config, sessionID, requestID) {
  if (!validSessionID(sessionID) || !validRequestID(requestID)) throw codedError("invalid")
  const url = apiURL(
    config,
    `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`,
  )
  await request(config, url, { method: "POST", body: JSON.stringify({ decision: "always" }) })
}

function createAutonomyManager(options = {}) {
  const pollInterval =
    Number.isInteger(options.pollInterval) && options.pollInterval >= 0 ? options.pollInterval : POLL_INTERVAL
  const settleMs = Number.isInteger(options.settleMs) && options.settleMs >= 0 ? options.settleMs : SETTLE_MS
  const now = typeof options.now === "function" ? options.now : Date.now
  const wait =
    typeof options.wait === "function"
      ? options.wait
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const setTimer = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout
  const clearTimer = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout

  const entries = new Map()
  const enabling = new Map()
  const parents = new Map()
  const recentlyReplied = new Map()
  const replying = new Set()
  let disposed = false

  function stateFor(sessionID) {
    const entry = entries.get(sessionID)
    return entry ? { enabled: true, status: entry.status } : { enabled: false, status: "off" }
  }

  function pruneHandled(at) {
    for (const [id, time] of recentlyReplied) {
      if (at - time > HANDLED_TTL) recentlyReplied.delete(id)
    }
    while (recentlyReplied.size > MAX_HANDLED) {
      const oldest = recentlyReplied.keys().next()
      if (oldest.done) break
      recentlyReplied.delete(oldest.value)
    }
  }

  function wasHandled(id) {
    const time = recentlyReplied.get(id)
    return time !== undefined && now() - time <= HANDLED_TTL
  }

  async function isFamily(config, sessionID, rootID, rootLocation) {
    if (sessionID === rootID) return true
    if (!validSessionID(sessionID) || !validSessionID(rootID)) return false
    let current = sessionID
    const seen = new Set()
    for (let depth = 0; depth < MAX_ANCESTRY; depth++) {
      if (seen.has(current)) return false
      seen.add(current)
      let cached = parents.get(current)
      if (cached === undefined) {
        try {
          const info = await readSessionInfo(config, current)
          cached = { parentID: info.parentID, location: info.location }
        } catch (error) {
          if (error?.code === "not_found") {
            cached = { parentID: null, location: null }
          } else {
            throw error
          }
        }
        if (parents.size >= MAX_PARENT_CACHE) parents.clear()
        parents.set(current, cached)
      }
      if (cached.location !== rootLocation) return false
      if (cached.parentID === null) return false
      if (cached.parentID === rootID) return true
      current = cached.parentID
    }
    return false
  }

  function fail(entry) {
    if (!entry.active || disposed) return
    entry.failures = Math.min(entry.failures + 1, FAILURE_LIMIT)
    if (entry.failures >= FAILURE_LIMIT) entry.status = "error"
  }

  function succeed(entry) {
    if (!entry.active || disposed) return
    entry.failures = 0
    entry.status = "on"
  }

  async function replyAll(entry, requests) {
    const results = new Array(requests.length)
    let index = 0
    const workers = Array.from({ length: Math.min(4, requests.length) }, async () => {
      for (;;) {
        const own = index++
        if (own >= requests.length) return
        const item = requests[own]
        if (!entry.active || disposed) {
          results[own] = "stopped"
          continue
        }
        if (wasHandled(item.id)) {
          entry.ignored.add(item.id)
          results[own] = "ok"
          continue
        }
        if (replying.has(item.id)) {
          results[own] = "ok"
          continue
        }
        replying.add(item.id)
        try {
          await replyAlways(entry.config, item.sessionID, item.id)
          recentlyReplied.set(item.id, now())
          pruneHandled(now())
          entry.ignored.add(item.id)
          results[own] = "ok"
        } catch (error) {
          if (error?.code === "not_found") {
            recentlyReplied.set(item.id, now())
            pruneHandled(now())
            entry.ignored.add(item.id)
            results[own] = "gone"
          } else {
            results[own] = "error"
          }
        } finally {
          replying.delete(item.id)
        }
      }
    })
    await Promise.all(workers)
    return results
  }

  async function runCycle(entry) {
    if (!entry.active || disposed) return
    let pending
    try {
      pending = await listPending(entry.config, entry.location)
    } catch {
      fail(entry)
      return
    }
    if (!entry.active || disposed) return

    const present = new Set(pending.map((item) => item.id))
    for (const id of [...entry.ignored]) {
      if (!present.has(id)) entry.ignored.delete(id)
    }
    pruneHandled(now())

    let failed = false
    const candidates = []
    const seen = new Set()
    for (const item of pending) {
      if (!entry.active || disposed) return
      if (seen.has(item.id)) continue
      seen.add(item.id)
      if (entry.ignored.has(item.id)) continue
      if (wasHandled(item.id)) {
        entry.ignored.add(item.id)
        continue
      }
      if (item.sessionID !== entry.rootID) {
        let family = false
        try {
          family = await isFamily(entry.config, item.sessionID, entry.rootID, entry.location)
        } catch {
          failed = true
          continue
        }
        if (!family) continue
      }
      if (!entry.active || disposed) return
      candidates.push(item)
    }

    const results = await replyAll(entry, candidates)
    if (!entry.active || disposed) return
    for (const result of results) {
      if (result !== "ok" && result !== "gone") failed = true
    }
    if (failed) fail(entry)
    else succeed(entry)
  }

  function schedule(entry, delay) {
    if (!entry.active || disposed) return
    if (entry.timer !== undefined) {
      clearTimer(entry.timer)
      entry.timer = undefined
    }
    entry.timer = setTimer(() => {
      entry.timer = undefined
      if (!entry.active || disposed) return
      const cycle = runCycle(entry).catch(() => fail(entry))
      entry.cycle = cycle
      cycle.finally(() => {
        if (entry.cycle === cycle) entry.cycle = undefined
        if (entry.active && !disposed) schedule(entry, pollInterval)
      })
    }, delay)
    entry.timer.unref?.()
  }

  async function doEnable(sessionID) {
    const config = await readServiceConfig()
    const info = await readSessionInfo(config, sessionID)
    const first = await listPending(config, info.location)
    let second = first
    if (settleMs > 0) {
      await wait(settleMs)
      second = await listPending(config, info.location)
    }
    if (disposed) throw codedError("unavailable")
    const ignored = new Set()
    for (const item of first) ignored.add(item.id)
    for (const item of second) ignored.add(item.id)
    if (ignored.size > MAX_PENDING) throw codedError("unavailable")
    const entry = {
      rootID: sessionID,
      config,
      location: info.location,
      ignored,
      active: true,
      status: "on",
      failures: 0,
      timer: undefined,
      cycle: undefined,
    }
    entries.set(sessionID, entry)
    schedule(entry, 0)
    return { enabled: true, status: "on", already: false }
  }

  async function enable(sessionID, acknowledged) {
    if (!validSessionID(sessionID)) throw codedError("invalid")
    if (acknowledged !== true) throw codedError("confirmation")
    if (disposed) throw codedError("unavailable")
    const existing = entries.get(sessionID)
    if (existing) return { ...stateFor(sessionID), already: true }
    const inFlight = enabling.get(sessionID)
    if (inFlight) {
      await inFlight
      return { ...stateFor(sessionID), already: true }
    }
    const operation = doEnable(sessionID)
    enabling.set(sessionID, operation)
    try {
      return await operation
    } finally {
      if (enabling.get(sessionID) === operation) enabling.delete(sessionID)
    }
  }

  async function disable(sessionID) {
    if (!validSessionID(sessionID)) throw codedError("invalid")
    const inFlight = enabling.get(sessionID)
    if (inFlight) {
      try {
        await inFlight
      } catch {
        // The enable failed, so there is nothing to disable.
      }
    }
    const entry = entries.get(sessionID)
    if (!entry) return { enabled: false, status: "off" }
    entry.active = false
    entries.delete(sessionID)
    if (entry.timer !== undefined) {
      clearTimer(entry.timer)
      entry.timer = undefined
    }
    if (entry.cycle) {
      try {
        await entry.cycle
      } catch {
        // A stopped cycle must not prevent the mode from turning off.
      }
    }
    return { enabled: false, status: "off" }
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    const cycles = []
    for (const entry of entries.values()) {
      entry.active = false
      if (entry.timer !== undefined) {
        clearTimer(entry.timer)
        entry.timer = undefined
      }
      if (entry.cycle) cycles.push(entry.cycle)
    }
    entries.clear()
    await Promise.allSettled(cycles)
  }

  return { state: stateFor, enable, disable, dispose }
}

function validSender(event) {
  const raw = event?.senderFrame?.url
  if (typeof raw !== "string") return false
  try {
    const url = new URL(raw)
    return url.protocol === "oc:" && url.hostname === "renderer"
  } catch {
    return false
  }
}

function reasonFor(error) {
  const code = error?.code
  if (code === "confirmation" || code === "invalid" || code === "not_found" || code === "unavailable") {
    return code
  }
  return "error"
}

function registerAutonomyIPC(options = {}) {
  const { ipcMain, manager = createAutonomyManager(), app } = options
  if (!ipcMain || typeof ipcMain.handle !== "function" || typeof ipcMain.removeHandler !== "function") {
    throw new TypeError("ipcMain is unavailable")
  }
  if (
    !manager ||
    typeof manager.state !== "function" ||
    typeof manager.enable !== "function" ||
    typeof manager.disable !== "function" ||
    typeof manager.dispose !== "function"
  ) {
    throw new TypeError("Autonomy manager is unavailable")
  }

  const stateHandler = async (event, sessionID) => {
    if (!validSender(event)) return { ok: false, reason: "forbidden" }
    if (!validSessionID(sessionID)) return { ok: false, reason: "invalid" }
    const state = manager.state(sessionID)
    return { ok: true, enabled: state.enabled, status: state.status }
  }

  const enableHandler = async (event, sessionID, acknowledged) => {
    if (!validSender(event)) return { ok: false, reason: "forbidden" }
    if (!validSessionID(sessionID)) return { ok: false, reason: "invalid" }
    if (acknowledged !== true) return { ok: false, reason: "confirmation" }
    try {
      const result = await manager.enable(sessionID, true)
      return {
        ok: true,
        enabled: result.enabled,
        status: result.status,
        already: result.already === true,
      }
    } catch (error) {
      return { ok: false, reason: reasonFor(error) }
    }
  }

  const disableHandler = async (event, sessionID) => {
    if (!validSender(event)) return { ok: false, reason: "forbidden" }
    if (!validSessionID(sessionID)) return { ok: false, reason: "invalid" }
    try {
      const result = await manager.disable(sessionID)
      return { ok: true, enabled: result.enabled, status: result.status }
    } catch {
      return { ok: false, reason: "error" }
    }
  }

  function dispose() {
    ipcMain.removeHandler(CHANNELS.state)
    ipcMain.removeHandler(CHANNELS.enable)
    ipcMain.removeHandler(CHANNELS.disable)
    manager.dispose().catch(() => {})
  }

  ipcMain.removeHandler(CHANNELS.state)
  ipcMain.removeHandler(CHANNELS.enable)
  ipcMain.removeHandler(CHANNELS.disable)
  ipcMain.handle(CHANNELS.state, stateHandler)
  ipcMain.handle(CHANNELS.enable, enableHandler)
  ipcMain.handle(CHANNELS.disable, disableHandler)
  if (app && typeof app.once === "function") app.once("before-quit", dispose)
  return dispose
}

module.exports = {
  CHANNELS,
  MAX_PENDING,
  POLL_INTERVAL,
  SETTLE_MS,
  createAutonomyManager,
  registerAutonomyIPC,
  validSessionID,
  validRequestID,
  validSender,
  serviceConfigPath,
  readServiceConfig,
  readSessionInfo,
  listPending,
  replyAlways,
  sessionInfoFrom,
  pendingFrom,
}
