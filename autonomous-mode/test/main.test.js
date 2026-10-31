import assert from "node:assert/strict"
import { after, afterEach, before, beforeEach, test } from "node:test"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  CHANNELS,
  MAX_PENDING,
  createAutonomyManager,
  listPending,
  pendingFrom,
  readServiceConfig,
  readSessionInfo,
  registerAutonomyIPC,
  replyAlways,
  sessionInfoFrom,
  serviceConfigPath,
  validRequestID,
  validSender,
  validSessionID,
} from "../main.cjs"

const PASSWORD = "test-password-0123456789"
const MARKER = "PRIVATE_MARKER_DO_NOT_LEAK"
const DEFAULT_LOCATION = "C:/autonomy/tests/default"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const clone = (value) => structuredClone(value)

let tempRoot
let previousState
let service
let port

function createMockService() {
  const sessions = new Map()
  const pending = new Map()
  const replies = []
  const requests = []
  const sessionFetches = new Map()
  const sockets = new Set()
  const modes = {
    list: "ok",
    reply: "ok",
    session: "ok",
    listDelay: 0,
    replyDelay: 0,
    sessionDelay: 0,
    duplicateList: false,
    keepPending: new Set(),
    onFirstList: undefined,
    listCalls: 0,
    listAttempts: 0,
    replyAttempts: 0,
    replyStarts: 0,
    startedIDs: new Set(),
  }
  let server

  function addSession(id, info = {}) {
    sessions.set(id, {
      parentID: info.parentID ?? null,
      location: info.location ?? DEFAULT_LOCATION,
      malformed: info.malformed === true,
    })
  }

  function removeSession(id) {
    sessions.delete(id)
  }

  function addPending(id, sessionID, location) {
    const place = location ?? sessions.get(sessionID)?.location ?? DEFAULT_LOCATION
    pending.set(id, {
      id,
      sessionID,
      location: place,
      action: "shell",
      resources: ["echo autonomy-test"],
    })
  }

  function removePending(id) {
    pending.delete(id)
  }

  function listFor(directory) {
    return [...pending.values()]
      .filter((item) => item.location === directory)
      .map(({ id, sessionID, action, resources }) => ({ id, sessionID, action, resources }))
  }

  function replyCount(id) {
    return replies.filter((item) => item.id === id).length
  }

  function replyStarted(id) {
    return modes.startedIDs.has(id)
  }

  function repliedIDs() {
    return replies.map((item) => item.id)
  }

  function reset() {
    sessions.clear()
    pending.clear()
    replies.length = 0
    requests.length = 0
    sessionFetches.clear()
    modes.list = "ok"
    modes.reply = "ok"
    modes.session = "ok"
    modes.listDelay = 0
    modes.replyDelay = 0
    modes.sessionDelay = 0
    modes.duplicateList = false
    modes.keepPending.clear()
    modes.onFirstList = undefined
    modes.listCalls = 0
    modes.listAttempts = 0
    modes.replyAttempts = 0
    modes.replyStarts = 0
    modes.startedIDs.clear()
  }

  function send(response, status, body, type = "application/json") {
    const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)
    response.writeHead(status, {
      "content-type": type,
      "content-length": Buffer.byteLength(text),
    })
    response.end(text)
  }

  async function readJSON(request) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 1024 * 1024) throw new Error("request too large")
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString("utf8")
    return text === "" ? {} : JSON.parse(text)
  }

  async function handler(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const pathname = url.pathname
    requests.push({ method: request.method, path: pathname })

    const expected = "Basic " + Buffer.from(`opencode:${PASSWORD}`, "utf8").toString("base64")
    if (request.headers.authorization !== expected) {
      send(response, 401, { error: MARKER })
      return
    }

    if (request.method === "GET" && pathname === "/api/permission/request") {
      const directory = url.searchParams.get("location[directory]") ?? ""
      modes.listAttempts++
      if (modes.listDelay > 0) await sleep(modes.listDelay)
      if (modes.list === "fail") {
        send(response, 500, { error: MARKER })
        return
      }
      if (modes.list === "invalid") {
        send(response, 200, `not-json:${MARKER}`, "text/plain")
        return
      }
      if (modes.list === "oversized") {
        const text = "x".repeat(1024 * 1024 + 1)
        response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) })
        response.end(text)
        return
      }
      if (modes.list === "wrong-location") {
        send(response, 200, { data: listFor(directory), location: { directory: `${directory}:other` } })
        return
      }
      if (modes.list === "too-many") {
        const data = Array.from({ length: MAX_PENDING + 1 }, (_, index) => ({
          id: `per_many_${index}`,
          sessionID: "ses_many",
        }))
        send(response, 200, { data, location: { directory } })
        return
      }
      if (modes.list === "invalid-id") {
        send(response, 200, {
          data: [{ id: "bad id", sessionID: "ses_any" }],
          location: { directory },
        })
        return
      }
      let data = listFor(directory)
      if (modes.duplicateList) data = [...data, ...data]
      if (modes.listCalls++ === 0 && modes.onFirstList) {
        const hook = modes.onFirstList
        modes.onFirstList = undefined
        hook()
      }
      send(response, 200, { data, location: { directory } })
      return
    }

    const sessionMatch = pathname.match(/^\/api\/session\/([^/]+)$/)
    if (request.method === "GET" && sessionMatch) {
      let id
      try {
        id = decodeURIComponent(sessionMatch[1])
      } catch {
        send(response, 400, { error: MARKER })
        return
      }
      sessionFetches.set(id, (sessionFetches.get(id) ?? 0) + 1)
      if (modes.sessionDelay > 0) await sleep(modes.sessionDelay)
      if (modes.session === "fail") {
        send(response, 500, { error: MARKER })
        return
      }
      const info = sessions.get(id)
      if (!info) {
        send(response, 404, { error: MARKER })
        return
      }
      if (info.malformed) {
        send(response, 200, { data: { id, parentID: "bad", location: null } })
        return
      }
      send(response, 200, {
        data: {
          id,
          parentID: info.parentID,
          location: { directory: info.location },
          title: MARKER,
        },
      })
      return
    }

    const replyMatch = pathname.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/)
    if (request.method === "POST" && replyMatch) {
      modes.replyStarts++
      let id, sessionID, body
      try {
        sessionID = decodeURIComponent(replyMatch[1])
        id = decodeURIComponent(replyMatch[2])
        body = await readJSON(request)
      } catch {
        send(response, 400, { error: MARKER })
        return
      }
      modes.startedIDs.add(id)
      if (modes.replyDelay > 0) await sleep(modes.replyDelay)
      modes.replyAttempts++
      if (modes.reply === "fail") {
        send(response, 500, { error: MARKER })
        return
      }
      if (modes.reply === "missing") {
        send(response, 404, { error: MARKER })
        return
      }
      const item = pending.get(id)
      if (!item || item.sessionID !== sessionID || body.decision !== "always") {
        send(response, 404, { error: MARKER })
        return
      }
      replies.push({ sessionID: item.sessionID, id: item.id, decision: body.decision })
      if (!modes.keepPending.has(item.id)) pending.delete(item.id)
      response.writeHead(204)
      response.end()
      return
    }

    send(response, 404, { error: MARKER })
  }

  return {
    get port() {
      return port
    },
    get url() {
      return `http://127.0.0.1:${port}`
    },
    sessions,
    pending,
    replies,
    requests,
    modes,
    sessionFetches,
    addSession,
    removeSession,
    addPending,
    removePending,
    replyCount,
    repliedIDs,
    replyStarted,
    reset,
    async start() {
      server = createServer((request, response) => {
        handler(request, response).catch(() => {
          if (!response.headersSent) send(response, 500, { error: MARKER })
          else response.destroy()
        })
      })
      server.on("connection", (socket) => {
        sockets.add(socket)
        socket.on("close", () => sockets.delete(socket))
      })
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
      port = server.address().port
    },
    async stop() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function makeManager(options = {}) {
  const manager = createAutonomyManager({ settleMs: 0, pollInterval: 10, ...options })
  managers.push(manager)
  return manager
}

const managers = []

async function setConfig(value) {
  await mkdir(join(tempRoot, "opencode"), { recursive: true })
  const text = typeof value === "string" ? value : JSON.stringify(value)
  await writeFile(join(tempRoot, "opencode", "service.json"), text, "utf8")
}

async function waitFor(check, timeout = 3_000) {
  const started = Date.now()
  for (;;) {
    let value = false
    try {
      value = await check()
    } catch {
      value = false
    }
    if (value) return true
    if (Date.now() - started > timeout) return false
    await sleep(10)
  }
}

function coded(error, code) {
  return error?.code === code
}

before(async () => {
  previousState = process.env.XDG_STATE_HOME
  tempRoot = await mkdtemp(join(tmpdir(), "autonomy-main-test-"))
  process.env.XDG_STATE_HOME = tempRoot
  service = createMockService()
  await service.start()
  await setConfig({ url: service.url, password: PASSWORD })
})

afterEach(async () => {
  const active = managers.splice(0)
  await Promise.allSettled(active.map((manager) => manager.dispose()))
})

beforeEach(async () => {
  service.reset()
  await setConfig({ url: service.url, password: PASSWORD })
})

after(async () => {
  await service.stop()
  await rm(tempRoot, { recursive: true, force: true })
  if (previousState === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = previousState
})

test("service configuration path, size and secret handling are strict", async () => {
  assert.equal(serviceConfigPath(), join(tempRoot, "opencode", "service.json"))

  const config = await readServiceConfig()
  assert.equal(config.url.port, String(service.port))
  assert.equal(config.password, PASSWORD)

  process.env.XDG_STATE_HOME = `  ${tempRoot}  `
  assert.equal(serviceConfigPath(), join(tempRoot, "opencode", "service.json"))
  process.env.XDG_STATE_HOME = "relative-path"
  assert.equal(serviceConfigPath(), join(homedir(), ".local", "state", "opencode", "service.json"))
  process.env.XDG_STATE_HOME = tempRoot

  const invalidURLs = [
    "",
    `http://127.0.0.1`,
    `http://localhost:${service.port}`,
    `https://127.0.0.1:${service.port}`,
    `http://127.0.0.1:0`,
    `http://127.0.0.1:${service.port}/path`,
    `http://127.0.0.1:${service.port}?query=1`,
    `http://127.0.0.1:${service.port}#fragment`,
    `http://user:password@127.0.0.1:${service.port}`,
    `ftp://127.0.0.1:${service.port}`,
    `https://${MARKER}`,
    null,
    42,
  ]
  for (const url of invalidURLs) {
    await setConfig({ url, password: PASSWORD })
    await assert.rejects(readServiceConfig(), (error) => {
      assert.equal(error.message, "Autonomy service request failed")
      assert.equal(error.message.includes(MARKER), false)
      return error.code === "unavailable"
    })
  }

  const invalidPasswords = ["", "short\npassword", "short\rpassword", "short\0password", null, 123, "x".repeat(1025)]
  for (const password of invalidPasswords) {
    await setConfig({ url: service.url, password })
    await assert.rejects(readServiceConfig(), (error) => error.code === "unavailable")
  }

  await setConfig({ url: service.url })
  await assert.rejects(readServiceConfig(), (error) => error.code === "unavailable")
  await setConfig([])
  await assert.rejects(readServiceConfig(), (error) => error.code === "unavailable")
  await setConfig("not json")
  await assert.rejects(readServiceConfig(), (error) => error.code === "unavailable")
  await setConfig("x".repeat(64 * 1024 + 1))
  await assert.rejects(readServiceConfig(), (error) => error.code === "unavailable")

  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = join(tempRoot, "missing-state")
  await assert.rejects(readServiceConfig(), (error) => error.code === "unavailable")
  process.env.XDG_STATE_HOME = previous
  await setConfig({ url: service.url, password: PASSWORD })
})

test("session, pending and sender payload validation is exact", () => {
  const valid = {
    data: {
      id: "ses_a",
      parentID: "ses_b",
      location: { directory: "C:/work" },
      title: MARKER,
    },
  }
  assert.deepEqual(sessionInfoFrom(valid, "ses_a"), {
    id: "ses_a",
    parentID: "ses_b",
    location: "C:/work",
  })
  assert.equal(sessionInfoFrom({ data: { id: "ses_a", location: { directory: "C:/work" } } }, "ses_a").parentID, null)
  assert.equal(
    sessionInfoFrom({ data: { id: "ses_a", parentID: null, location: { directory: "C:/work" } } }, "ses_a").parentID,
    null,
  )
  const invalidSessions = [
    null,
    {},
    { data: null },
    { data: { id: "ses_b", location: { directory: "C:/work" } } },
    { data: { id: "ses_a", location: {} } },
    { data: { id: "ses_a", location: { directory: "" } } },
    { data: { id: "ses_a", location: { directory: "C:/bad\npath" } } },
    { data: { id: "ses_a", location: { directory: `C:/${"x".repeat(4097)}` } } },
    { data: { id: "ses_a", parentID: "bad", location: { directory: "C:/work" } } },
    { data: { id: "ses_a", parentID: 7, location: { directory: "C:/work" } } },
  ]
  for (const value of invalidSessions) assert.throws(() => sessionInfoFrom(value, "ses_a"))

  const pending = pendingFrom(
    {
      data: [
        { id: "per_a", sessionID: "ses_a", action: "shell", resources: ["echo"], extra: MARKER },
        { id: "per_b", sessionID: "ses_b" },
      ],
      location: { directory: "C:/work" },
    },
    "C:/work",
  )
  assert.deepEqual(pending, [
    { id: "per_a", sessionID: "ses_a" },
    { id: "per_b", sessionID: "ses_b" },
  ])
  assert.deepEqual(pendingFrom({ data: [], location: { directory: "C:/work" } }, "C:/work"), [])

  const many = Array.from({ length: MAX_PENDING }, (_, index) => ({
    id: `per_${index}`,
    sessionID: "ses_a",
  }))
  assert.equal(pendingFrom({ data: many, location: { directory: "C:/work" } }, "C:/work").length, MAX_PENDING)
  assert.throws(() =>
    pendingFrom({ data: [...many, { id: "per_extra", sessionID: "ses_a" }], location: { directory: "C:/work" } }, "C:/work"),
  )
  const invalidPending = [
    null,
    {},
    { data: "nope", location: { directory: "C:/work" } },
    { data: [], location: { directory: "C:/other" } },
    { data: [], location: null },
    { data: [{ id: "bad id", sessionID: "ses_a" }], location: { directory: "C:/work" } },
    { data: [{ id: "per_a", sessionID: "bad id" }], location: { directory: "C:/work" } },
    { data: [null], location: { directory: "C:/work" } },
  ]
  for (const value of invalidPending) assert.throws(() => pendingFrom(value, "C:/work"))

  for (const value of ["ses_a", "ses_A-1_2", `ses_${"a".repeat(256)}`]) assert.equal(validSessionID(value), true)
  for (const value of ["", "ses_", `ses_${"a".repeat(257)}`, "ses_a\n", "ses_a\0", "ses_a/b", "ses_тест", null, 1]) {
    assert.equal(validSessionID(value), false)
  }
  for (const value of ["per_a", "per_A-1_2", "perm_a", `per_${"a".repeat(255)}`]) assert.equal(validRequestID(value), true)
  for (const value of ["", `per_${"a".repeat(256)}`, "per_a\n", "per_a/b", null, 1]) {
    assert.equal(validRequestID(value), false)
  }

  const sender = { senderFrame: { url: "oc://renderer/index.html" } }
  assert.equal(validSender(sender), true)
  assert.equal(validSender({ senderFrame: { url: "oc://renderer/" } }), true)
  assert.equal(validSender({ senderFrame: { url: "oc://renderer" } }), true)
  for (const value of [
    undefined,
    {},
    { senderFrame: null },
    { senderFrame: { url: "https://renderer/" } },
    { senderFrame: { url: "oc://elsewhere/" } },
    { senderFrame: { url: "file://renderer/" } },
    { senderFrame: { url: "not a url" } },
    { senderFrame: { url: 7 } },
  ]) {
    assert.equal(validSender(value), false)
  }
})

test("HTTP helpers send credentials, reply always and map every failure generically", async () => {
  const root = "ses_helper_root"
  const location = "C:/autonomy/tests/helpers"
  service.addSession(root, { location })
  service.addPending("per_helper", root)

  const config = await readServiceConfig()
  assert.deepEqual(await readSessionInfo(config, root), { id: root, parentID: null, location })
  assert.deepEqual(await listPending(config, location), [{ id: "per_helper", sessionID: root }])

  const before = service.requests.length
  await assert.rejects(listPending(config, ""), (error) => coded(error, "invalid"))
  await assert.rejects(listPending(config, "C:/bad\nlocation"), (error) => coded(error, "invalid"))
  await assert.rejects(replyAlways(config, "bad", "per_helper"), (error) => coded(error, "invalid"))
  await assert.rejects(replyAlways(config, root, "bad"), (error) => coded(error, "invalid"))
  await assert.rejects(readSessionInfo(config, "bad"), (error) => coded(error, "invalid"))
  assert.equal(service.requests.length, before)

  await replyAlways(config, root, "per_helper")
  assert.deepEqual(service.replies, [{ sessionID: root, id: "per_helper", decision: "always" }])
  assert.equal(service.pending.has("per_helper"), false)
  await assert.rejects(replyAlways(config, root, "per_helper"), (error) => coded(error, "not_found"))
  await assert.rejects(readSessionInfo(config, "ses_missing"), (error) => coded(error, "not_found"))

  service.modes.list = "wrong-location"
  await assert.rejects(listPending(config, location), (error) => coded(error, "unavailable"))
  service.modes.list = "invalid"
  await assert.rejects(listPending(config, location), (error) => coded(error, "unavailable"))
  service.modes.list = "oversized"
  await assert.rejects(listPending(config, location), (error) => coded(error, "unavailable"))
  service.modes.list = "too-many"
  await assert.rejects(listPending(config, location), (error) => coded(error, "unavailable"))
  service.modes.list = "invalid-id"
  await assert.rejects(listPending(config, location), (error) => coded(error, "unavailable"))
  service.modes.list = "fail"
  await assert.rejects(listPending(config, location), (error) => {
    assert.equal(error.message.includes(MARKER), false)
    return error.code === "unavailable"
  })
  service.modes.list = "ok"

  service.addPending("per_reply_fail", root)
  service.modes.reply = "fail"
  await assert.rejects(replyAlways(config, root, "per_reply_fail"), (error) => {
    assert.equal(error.message, "Autonomy service request failed")
    assert.equal(error.message.includes(MARKER), false)
    return error.code === "unavailable"
  })
  service.modes.reply = "missing"
  await assert.rejects(replyAlways(config, root, "per_reply_fail"), (error) => coded(error, "not_found"))
  service.modes.reply = "ok"

  service.addSession("ses_malformed", { malformed: true })
  await assert.rejects(readSessionInfo(config, "ses_malformed"), (error) => coded(error, "unavailable"))

  await setConfig({ url: service.url, password: "wrong-password" })
  const wrong = await readServiceConfig()
  await assert.rejects(listPending(wrong, location), (error) => {
    assert.equal(error.message.includes(MARKER), false)
    return error.code === "unavailable"
  })
  await setConfig({ url: service.url, password: PASSWORD })

  assert.ok(
    service.requests.every((item) => item.method === "GET" || (item.method === "POST" && item.path.endsWith("/reply"))),
  )
  assert.equal(service.requests.some((item) => item.method === "PATCH"), false)
  assert.ok(
    service.requests.every((item) => {
      if (item.method === "GET") {
        return item.path === "/api/permission/request" || /^\/api\/session\/[^/]+$/.test(item.path)
      }
      if (item.method === "POST") return /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(item.path)
      return false
    }),
  )
})

test("enable needs a valid session and explicit confirmation", async () => {
  const root = "ses_enable_root"
  const location = "C:/autonomy/tests/enable"
  service.addSession(root, { location })
  const manager = makeManager()

  await assert.rejects(manager.enable("bad", true), (error) => coded(error, "invalid"))
  await assert.rejects(manager.enable(root, false), (error) => coded(error, "confirmation"))
  await assert.rejects(manager.enable(root, "true"), (error) => coded(error, "confirmation"))
  assert.equal(service.requests.length, 0)
  assert.deepEqual(manager.state(root), { enabled: false, status: "off" })

  await assert.rejects(manager.enable("ses_unknown", true), (error) => coded(error, "not_found"))
  service.modes.session = "fail"
  await assert.rejects(manager.enable(root, true), (error) => coded(error, "unavailable"))
  service.modes.session = "ok"

  service.modes.list = "fail"
  await assert.rejects(manager.enable(root, true), (error) => coded(error, "unavailable"))
  service.modes.list = "ok"

  const result = await manager.enable(root, true)
  assert.deepEqual(result, { enabled: true, status: "on", already: false })
  assert.deepEqual(manager.state(root), { enabled: true, status: "on" })
  const again = await manager.enable(root, true)
  assert.deepEqual(again, { enabled: true, status: "on", already: true })
  assert.deepEqual(await manager.disable(root), { enabled: false, status: "off" })
  assert.deepEqual(manager.state(root), { enabled: false, status: "off" })
  await assert.rejects(manager.enable("bad", true), (error) => coded(error, "invalid"))
  await assert.rejects(manager.disable("bad"), (error) => coded(error, "invalid"))
  assert.deepEqual(await manager.disable("ses_never_enabled"), { enabled: false, status: "off" })
})

test("concurrent enable is idempotent, and a concurrent failure leaves nothing enabled", async () => {
  const root = "ses_concurrent_root"
  service.addSession(root, { location: "C:/autonomy/tests/concurrent" })
  const manager = makeManager({ pollInterval: 1_000 })
  service.modes.sessionDelay = 60
  const first = manager.enable(root, true)
  const second = manager.enable(root, true)
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, { enabled: true, status: "on", already: false })
  assert.deepEqual(b, { enabled: true, status: "on", already: true })
  assert.equal(service.sessionFetches.get(root), 1)
  await manager.disable(root)

  service.modes.session = "fail"
  const failing = manager.enable(root, true)
  const waiting = manager.enable(root, true)
  const results = await Promise.allSettled([failing, waiting])
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"])
  assert.ok(results.every((result) => result.reason?.code === "unavailable"))
  assert.deepEqual(manager.state(root), { enabled: false, status: "off" })
})

test("requests already pending at enable are snapshotted and never approved", async () => {
  const root = "ses_snapshot_root"
  const location = "C:/autonomy/tests/snapshot"
  service.addSession(root, { location })
  service.addPending("per_snapshot_old", root)
  const manager = makeManager()
  assert.deepEqual(await manager.enable(root, true), { enabled: true, status: "on", already: false })
  await sleep(100)
  assert.equal(service.replyCount("per_snapshot_old"), 0)

  service.addPending("per_snapshot_new", root)
  assert.ok(await waitFor(() => service.replyCount("per_snapshot_new") === 1))
  assert.equal(service.replyCount("per_snapshot_old"), 0)
  assert.deepEqual(service.repliedIDs(), ["per_snapshot_new"])
  assert.deepEqual(service.replies.map((item) => item.decision), ["always"])
})

test("a request arriving between the two enable snapshots is also protected", async () => {
  const root = "ses_settle_root"
  const location = "C:/autonomy/tests/settle"
  service.addSession(root, { location })
  service.modes.onFirstList = () => service.addPending("per_between_lists", root)
  const manager = makeManager({ settleMs: 20 })
  assert.deepEqual(await manager.enable(root, true), { enabled: true, status: "on", already: false })
  assert.equal(service.pending.has("per_between_lists"), true)
  assert.ok(service.modes.listCalls >= 2)
  await sleep(100)
  assert.equal(service.replyCount("per_between_lists"), 0)
})

test("new requests are approved exactly once and permissions are never written", async () => {
  const root = "ses_new_root"
  const location = "C:/autonomy/tests/new"
  service.addSession(root, { location })
  const manager = makeManager()
  await manager.enable(root, true)
  service.addPending("per_new_request", root)
  assert.ok(await waitFor(() => service.replyCount("per_new_request") === 1))
  await sleep(80)
  assert.equal(service.replyCount("per_new_request"), 1)
  assert.deepEqual(service.replies, [{ sessionID: root, id: "per_new_request", decision: "always" }])
  assert.equal(service.pending.has("per_new_request"), false)
  assert.equal(service.requests.some((item) => item.method === "PATCH"), false)
  assert.equal(service.requests.some((item) => item.path.endsWith("/permission")), false)
})

test("ancestry and location scope approvals to the selected session family", async () => {
  const root = "ses_root_ancestry"
  const child = "ses_child_ancestry"
  const grand = "ses_grand_ancestry"
  const stranger = "ses_stranger_ancestry"
  const otherLocation = "ses_other_location_ancestry"
  const cycleA = "ses_cycle_a_ancestry"
  const cycleB = "ses_cycle_b_ancestry"
  const location = "C:/autonomy/tests/ancestry"
  const other = "C:/autonomy/tests/ancestry-other"
  service.addSession(root, { location })
  service.addSession(child, { parentID: root, location })
  service.addSession(grand, { parentID: child, location })
  service.addSession(stranger, { location })
  service.addSession(otherLocation, { parentID: root, location: other })
  service.addSession(cycleA, { parentID: cycleB, location })
  service.addSession(cycleB, { parentID: cycleA, location })

  const chain = []
  let parent = root
  for (let index = 1; index <= 17; index++) {
    const id = `ses_deep_${index}_ancestry`
    service.addSession(id, { parentID: parent, location })
    chain.push(id)
    parent = id
  }

  const manager = makeManager()
  await manager.enable(root, true)
  service.addPending("per_root_ancestry", root)
  service.addPending("per_child_ancestry", child)
  service.addPending("per_grand_ancestry", grand)
  service.addPending("per_stranger_ancestry", stranger)
  service.addPending("per_other_location_ancestry", otherLocation)
  service.addPending("per_cycle_ancestry", cycleA)
  service.addPending("per_deep_16_ancestry", chain[15])
  service.addPending("per_deep_17_ancestry", chain[16])
  const expected = ["per_child_ancestry", "per_deep_16_ancestry", "per_grand_ancestry", "per_root_ancestry"]
  assert.ok(await waitFor(() => expected.every((id) => service.replyCount(id) === 1)))
  await sleep(150)
  assert.deepEqual(service.repliedIDs().slice().sort(), expected.slice().sort())
  for (const id of ["per_other_location_ancestry", "per_stranger_ancestry", "per_cycle_ancestry", "per_deep_17_ancestry"]) {
    assert.equal(service.replyCount(id), 0, id)
  }
  assert.deepEqual(manager.state(root), { enabled: true, status: "on" })
  assert.equal(service.requests.some((item) => item.method === "PATCH"), false)
})

test("two roots at the same location never approve each other's requests", async () => {
  const first = "ses_root_first"
  const second = "ses_root_second"
  const secondChild = "ses_child_second"
  const location = "C:/autonomy/tests/two-roots"
  service.addSession(first, { location })
  service.addSession(second, { location })
  service.addSession(secondChild, { parentID: second, location })

  const manager = makeManager()
  await manager.enable(first, true)
  await manager.enable(second, true)
  service.addPending("per_first_root", first)
  service.addPending("per_second_root", second)
  service.addPending("per_second_child", secondChild)
  assert.ok(
    await waitFor(
      () =>
        service.replyCount("per_first_root") === 1 &&
        service.replyCount("per_second_root") === 1 &&
        service.replyCount("per_second_child") === 1,
    ),
  )
  await sleep(100)
  assert.equal(service.replyCount("per_first_root"), 1)
  assert.equal(service.replyCount("per_second_root"), 1)
  assert.equal(service.replyCount("per_second_child"), 1)
  assert.equal(service.replies.every((item) => item.decision === "always"), true)
})

test("disable stops future approvals and waits for an in-flight reply", async () => {
  const root = "ses_disable_root"
  const location = "C:/autonomy/tests/disable"
  service.addSession(root, { location })
  const manager = makeManager()
  await manager.enable(root, true)
  service.addPending("per_before_disable", root)
  assert.ok(await waitFor(() => service.replyCount("per_before_disable") === 1))
  assert.deepEqual(await manager.disable(root), { enabled: false, status: "off" })
  assert.deepEqual(manager.state(root), { enabled: false, status: "off" })
  service.addPending("per_after_disable", root)
  await sleep(120)
  assert.equal(service.replyCount("per_after_disable"), 0)
  assert.deepEqual(await manager.disable(root), { enabled: false, status: "off" })

  const slowRoot = "ses_disable_slow"
  const slowLocation = "C:/autonomy/tests/disable-slow"
  service.addSession(slowRoot, { location: slowLocation })
  service.modes.replyDelay = 200
  const slow = makeManager()
  await slow.enable(slowRoot, true)
  service.addPending("per_in_flight", slowRoot)
  assert.ok(await waitFor(() => service.replyStarted("per_in_flight")))
  let finished = false
  const disabling = slow.disable(slowRoot).then(() => {
    finished = true
  })
  await sleep(40)
  assert.equal(finished, false)
  await disabling
  assert.equal(finished, true)
  assert.equal(service.replyCount("per_in_flight"), 1)
  service.addPending("per_after_slow_disable", slowRoot)
  await sleep(120)
  assert.equal(service.replyCount("per_after_slow_disable"), 0)
})

test("duplicate listings and requests that stay pending cannot cause duplicate replies", async () => {
  const root = "ses_duplicate_root"
  const location = "C:/autonomy/tests/duplicate"
  service.addSession(root, { location })
  service.modes.duplicateList = true
  service.modes.keepPending.add("per_duplicate")
  const manager = makeManager()
  await manager.enable(root, true)
  service.addPending("per_duplicate", root)
  assert.ok(await waitFor(() => service.replyCount("per_duplicate") === 1))
  await sleep(150)
  assert.equal(service.replyCount("per_duplicate"), 1)
  assert.equal(service.pending.has("per_duplicate"), true)

  service.modes.keepPending.delete("per_duplicate")
  service.removePending("per_duplicate")
  service.modes.duplicateList = false
  service.addPending("per_after_duplicate", root)
  assert.ok(await waitFor(() => service.replyCount("per_after_duplicate") === 1))
  await sleep(80)
  assert.equal(service.replyCount("per_after_duplicate"), 1)
})

test("list and reply failures become a bounded error state and recover", async () => {
  const root = "ses_failure_root"
  const location = "C:/autonomy/tests/failure"
  service.addSession(root, { location })
  const manager = makeManager()
  await manager.enable(root, true)

  service.modes.list = "fail"
  assert.ok(await waitFor(() => manager.state(root).status === "error"))
  assert.deepEqual(manager.state(root), { enabled: true, status: "error" })
  assert.ok(service.modes.listAttempts >= 4)
  service.modes.list = "ok"
  assert.ok(await waitFor(() => manager.state(root).status === "on"))

  service.addPending("per_reply_failure", root)
  service.modes.reply = "fail"
  assert.ok(await waitFor(() => manager.state(root).status === "error"))
  assert.ok(service.modes.replyAttempts >= 3)
  assert.equal(service.replyCount("per_reply_failure"), 0)
  assert.equal(service.pending.has("per_reply_failure"), true)
  service.modes.reply = "ok"
  assert.ok(await waitFor(() => service.replyCount("per_reply_failure") === 1))
  assert.ok(await waitFor(() => manager.state(root).status === "on"))
})

test("a reply that became not found is treated as gone without an error state", async () => {
  const root = "ses_missing_reply_root"
  const location = "C:/autonomy/tests/missing-reply"
  service.addSession(root, { location })
  service.modes.reply = "missing"
  const manager = makeManager()
  await manager.enable(root, true)
  service.addPending("per_missing_reply", root)
  assert.ok(await waitFor(() => service.modes.replyAttempts >= 1))
  await sleep(150)
  assert.deepEqual(manager.state(root), { enabled: true, status: "on" })
  assert.equal(service.replyCount("per_missing_reply"), 0)
  assert.equal(service.pending.has("per_missing_reply"), true)

  service.modes.reply = "ok"
  service.removePending("per_missing_reply")
  service.addPending("per_after_missing", root)
  assert.ok(await waitFor(() => service.replyCount("per_after_missing") === 1))
})

test("dispose stops all polling and cannot be bypassed by a later enable", async () => {
  const root = "ses_dispose_root"
  const location = "C:/autonomy/tests/dispose"
  service.addSession(root, { location })
  const manager = makeManager()
  await manager.enable(root, true)
  await manager.dispose()
  assert.deepEqual(manager.state(root), { enabled: false, status: "off" })
  service.addPending("per_after_dispose", root)
  await sleep(120)
  assert.equal(service.replyCount("per_after_dispose"), 0)
  await assert.rejects(manager.enable(root, true), (error) => coded(error, "unavailable"))
  assert.deepEqual(await manager.disable(root), { enabled: false, status: "off" })
  await manager.dispose()
})

test("hundreds of mixed requests are routed only to the enabled family", async () => {
  const root = "ses_stress_root"
  const child = "ses_stress_child"
  const grand = "ses_stress_grand"
  const stranger = "ses_stress_stranger"
  const otherRoot = "ses_stress_other_root"
  const location = "C:/autonomy/tests/stress"
  const other = "C:/autonomy/tests/stress-other"
  service.addSession(root, { location })
  service.addSession(child, { parentID: root, location })
  service.addSession(grand, { parentID: child, location })
  service.addSession(stranger, { location })
  service.addSession(otherRoot, { location: other })

  const accepted = new Set()
  const rejected = new Set()
  const manager = makeManager({ pollInterval: 20 })
  await manager.enable(root, true)
  service.modes.duplicateList = true
  for (let index = 0; index < 40; index++) {
    for (const [prefix, session] of [
      ["root", root],
      ["child", child],
      ["grand", grand],
    ]) {
      const id = `per_stress_${prefix}_${index}`
      service.addPending(id, session)
      accepted.add(id)
    }
    const strangerID = `per_stress_stranger_${index}`
    service.addPending(strangerID, stranger)
    rejected.add(strangerID)
    const otherID = `per_stress_other_${index}`
    service.addPending(otherID, otherRoot)
    rejected.add(otherID)
  }
  assert.ok(
    await waitFor(() => [...accepted].every((id) => service.replyCount(id) === 1), 6_000),
  )
  await sleep(250)
  for (const id of rejected) assert.equal(service.replyCount(id), 0, id)
  for (const id of accepted) assert.equal(service.replyCount(id), 1, id)
  assert.equal(service.replies.length, accepted.size)
  assert.equal(service.replies.every((item) => item.decision === "always"), true)
  assert.equal(service.requests.some((item) => item.method === "PATCH"), false)
})

test("renderer-facing code cannot see or log credentials, and main never logs", async () => {
  const rendererFiles = ["core.cjs", "controller.cjs", "ui.cjs", "preload.cjs"]
  for (const name of rendererFiles) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), "utf8")
    for (const forbidden of [
      "service.json",
      "password",
      "authorization",
      "Basic ",
      "console.log",
      "console.error",
      "console.warn",
      "process.env",
      "fs.",
      "fetch(",
    ]) {
      assert.equal(text.includes(forbidden), false, `${name} must not contain ${forbidden}`)
    }
    assert.equal(text.includes(MARKER), false, `${name} must not contain test secrets`)
  }
  const mainText = await readFile(new URL("../main.cjs", import.meta.url), "utf8")
  for (const forbidden of ["console.log", "console.error", "console.warn", "process.stdout", "process.stderr"]) {
    assert.equal(mainText.includes(forbidden), false, `main.cjs must not log`)
  }
})

test("requests spoofed into the root location but owned elsewhere are never approved", async () => {
  const root = "ses_spoof_root"
  const location = "C:/autonomy/tests/spoof"
  service.addSession(root, { location })
  service.addSession("ses_spoof_foreign", { location: "C:/autonomy/tests/spoof-elsewhere" })
  const manager = makeManager()
  await manager.enable(root, true)
  service.addPending("per_spoof_foreign", "ses_spoof_foreign", location)
  service.addPending("per_spoof_ghost", "ses_spoof_ghost", location)
  await sleep(150)
  assert.equal(service.replyCount("per_spoof_foreign"), 0)
  assert.equal(service.replyCount("per_spoof_ghost"), 0)
  service.addPending("per_spoof_own", root)
  assert.ok(await waitFor(() => service.replyCount("per_spoof_own") === 1))
  assert.equal(service.replyCount("per_spoof_foreign"), 0)
  assert.equal(service.replyCount("per_spoof_ghost"), 0)
})

test("a hung service times out and enable fails cleanly, then recovers", async () => {
  const root = "ses_hung_root"
  const location = "C:/autonomy/tests/hung"
  service.addSession(root, { location })
  const manager = makeManager()
  service.modes.sessionDelay = 6_000
  const started = Date.now()
  await assert.rejects(manager.enable(root, true), (error) => coded(error, "unavailable"))
  assert.ok(Date.now() - started >= 4_800)
  assert.deepEqual(manager.state(root), { enabled: false, status: "off" })
  service.modes.sessionDelay = 0
  await manager.enable(root, true)
  service.addPending("per_hung_new", root)
  assert.ok(await waitFor(() => service.replyCount("per_hung_new") === 1))
})

test("many roots at one location each approve only their own family", async () => {
  const location = "C:/autonomy/tests/many-roots"
  const roots = []
  for (let index = 0; index < 6; index++) {
    const id = `ses_many_root_${index}`
    service.addSession(id, { location })
    service.addSession(`ses_many_child_${index}`, { parentID: id, location })
    roots.push(id)
  }
  const manager = makeManager({ pollInterval: 20 })
  for (const id of roots) await manager.enable(id, true)
  const expected = []
  for (let index = 0; index < 6; index++) {
    service.addPending(`per_many_root_${index}`, roots[index])
    service.addPending(`per_many_child_${index}`, `ses_many_child_${index}`)
    expected.push(`per_many_root_${index}`, `per_many_child_${index}`)
  }
  assert.ok(await waitFor(() => expected.every((id) => service.replyCount(id) === 1), 6_000))
  await sleep(150)
  assert.equal(service.replies.length, expected.length)
  for (const id of expected) assert.equal(service.replyCount(id), 1, id)
  for (const id of roots) assert.deepEqual(await manager.disable(id), { enabled: false, status: "off" })
  assert.deepEqual(manager.state(roots[0]), { enabled: false, status: "off" })
})

function fakeManager() {
  const calls = []
  const manager = {
    calls,
    failCode: undefined,
    state(id) {
      calls.push(["state", id])
      return { enabled: id === "ses_on", status: id === "ses_on" ? "on" : "off", secret: MARKER }
    },
    async enable(id, acknowledgement) {
      calls.push(["enable", id, acknowledgement])
      if (manager.failCode) throw Object.assign(new Error(MARKER), { code: manager.failCode })
      return { enabled: true, status: "on", already: false, secret: MARKER }
    },
    async disable(id) {
      calls.push(["disable", id])
      if (manager.failCode) throw Object.assign(new Error(MARKER), { code: manager.failCode })
      return { enabled: false, status: "off", secret: MARKER }
    },
    async dispose() {
      calls.push(["dispose"])
    },
  }
  return manager
}

function fakeIpcMain() {
  const handlers = new Map()
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    },
  }
}

test("IPC validates sender, session and acknowledgement and allowlists errors", async () => {
  const ipcMain = fakeIpcMain()
  const manager = fakeManager()
  registerAutonomyIPC({ ipcMain, manager })
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), Object.values(CHANNELS).sort())
  const sender = { senderFrame: { url: "oc://renderer/index.html" } }
  const foreign = { senderFrame: { url: "https://example.com/" } }
  const state = ipcMain.handlers.get(CHANNELS.state)
  const enable = ipcMain.handlers.get(CHANNELS.enable)
  const disable = ipcMain.handlers.get(CHANNELS.disable)

  assert.deepEqual(await state(foreign, "ses_off"), { ok: false, reason: "forbidden" })
  assert.deepEqual(await state(sender, "bad"), { ok: false, reason: "invalid" })
  assert.deepEqual(await state(sender, "ses_off"), { ok: true, enabled: false, status: "off" })
  assert.deepEqual(await state(sender, "ses_on"), { ok: true, enabled: true, status: "on" })
  assert.equal(JSON.stringify(await state(sender, "ses_on")).includes(MARKER), false)

  assert.deepEqual(await enable(foreign, "ses_off", true), { ok: false, reason: "forbidden" })
  assert.deepEqual(await enable(sender, "bad", true), { ok: false, reason: "invalid" })
  assert.deepEqual(await enable(sender, "ses_off", false), { ok: false, reason: "confirmation" })
  assert.deepEqual(await enable(sender, "ses_off", "true"), { ok: false, reason: "confirmation" })

  for (const code of ["confirmation", "invalid", "not_found", "unavailable"]) {
    manager.failCode = code
    assert.deepEqual(await enable(sender, "ses_off", true), { ok: false, reason: code })
  }
  manager.failCode = "weird-private-code"
  assert.deepEqual(await enable(sender, "ses_off", true), { ok: false, reason: "error" })
  manager.failCode = undefined
  const success = await enable(sender, "ses_off", true)
  assert.deepEqual(success, { ok: true, enabled: true, status: "on", already: false })
  assert.deepEqual(Object.keys(success).sort(), ["already", "enabled", "ok", "status"])
  assert.equal(JSON.stringify(success).includes(MARKER), false)

  const disabled = await disable(sender, "ses_on")
  assert.deepEqual(disabled, { ok: true, enabled: false, status: "off" })
  assert.deepEqual(Object.keys(disabled).sort(), ["enabled", "ok", "status"])
  manager.failCode = "unavailable"
  assert.deepEqual(await disable(sender, "ses_on"), { ok: false, reason: "error" })
  assert.deepEqual(await disable(foreign, "ses_on"), { ok: false, reason: "forbidden" })
  assert.deepEqual(await disable(sender, "bad"), { ok: false, reason: "invalid" })
  manager.failCode = undefined

  assert.throws(() => registerAutonomyIPC({ manager }), TypeError)
  assert.throws(() => registerAutonomyIPC({ ipcMain: fakeIpcMain(), manager: {} }), TypeError)
})

test("IPC disposal removes handlers and application quit disposes the manager", async () => {
  const ipcMain = fakeIpcMain()
  const manager = fakeManager()
  let quit
  const app = {
    once(event, callback) {
      if (event === "before-quit") quit = callback
    },
  }
  const dispose = registerAutonomyIPC({ ipcMain, manager, app })
  assert.equal(typeof quit, "function")
  assert.equal(ipcMain.handlers.size, 3)
  dispose()
  assert.equal(ipcMain.handlers.size, 0)
  assert.ok(manager.calls.some(([name]) => name === "dispose"))
  await sleep(0)

  const secondIPC = fakeIpcMain()
  const second = fakeManager()
  registerAutonomyIPC({ ipcMain: secondIPC, manager: second, app })
  assert.equal(secondIPC.handlers.size, 3)
  quit()
  assert.equal(secondIPC.handlers.size, 0)
  assert.ok(second.calls.some(([name]) => name === "dispose"))
  await sleep(0)
})
