import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  MAX_TAB_TITLE_LENGTH,
  projectFolderName,
  sanitizeTabTitle,
  setupProjectFolderTabs,
  syncExistingSessions,
  watchCreatedSessions,
  type CreatedSessionEvent,
  type PluginContext,
  type SessionInfo,
} from "../core.ts"

function titleFrom(canonical: string): string {
  return projectFolderName({
    directory: canonical,
    project: { id: "symbols", directory: canonical, canonical },
  })
}

function isUnsafe(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    codePoint === 0x200b ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x2028 && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f)
  )
}

function firstUnsafeCodePoint(title: string): number | undefined {
  for (const character of title) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && isUnsafe(codePoint)) return codePoint
  }
  return undefined
}

function assertSafeTitle(title: string, label: string): void {
  assert.equal(typeof title, "string", label)
  assert.ok(title.length > 0, `${label}: empty title`)
  assert.ok(
    Array.from(title).length <= MAX_TAB_TITLE_LENGTH,
    `${label}: title exceeds ${MAX_TAB_TITLE_LENGTH} code points`,
  )
  assert.equal(title, title.trim(), `${label}: untrimmed title`)
  assert.ok(!title.includes("/") && !title.includes("\\"), `${label}: path separator`)
  const unsafe = firstUnsafeCodePoint(title)
  assert.equal(
    unsafe,
    undefined,
    unsafe === undefined ? label : `${label}: unsafe U+${unsafe.toString(16)}`,
  )
}

test("brutal/symbols: legitimate Unicode survives; terminal and direction controls do not", () => {
  const legitimate = [
    "plain-project",
    "проект",
    "项目",
    "プロジェクト",
    "프로젝트",
    "עברית",
    "مرحبا",
    "e\u0301",
    "é",
    "🚀",
    "👩🏽\u200d💻",
    "👨\u200d👩\u200d👧\u200d👦",
    "🇫🇮",
    "क्\u200cष",
    "𝐀𝐁𝐂",
    "' OR 1=1 --",
  ]
  for (const name of legitimate) {
    assert.equal(titleFrom(`/root/${name}`), name, `legitimate U+${name.codePointAt(0)?.toString(16)}`)
    assertSafeTitle(titleFrom(`/root/${name}`), "legitimate Unicode")
  }

  const hostile: Array<[string, string]> = [
    ["escape", "\u001b"],
    ["newline", "\n"],
    ["carriage-return", "\r"],
    ["tab", "\t"],
    ["nul", "\u0000"],
    ["bell", "\u0007"],
    ["c1-nel", "\u0085"],
    ["rtlo", "\u202e"],
    ["lre", "\u202a"],
    ["pdf", "\u202c"],
    ["rl-isolate", "\u2067"],
    ["pop-isolate", "\u2069"],
    ["line-separator", "\u2028"],
    ["paragraph-separator", "\u2029"],
    ["zero-width-space", "\u200b"],
    ["bom", "\ufeff"],
    ["soft-hyphen", "\u00ad"],
    ["lone-high-surrogate", "\ud800"],
    ["lone-low-surrogate", "\udfff"],
    ["unicode-tag", "\u{E0067}"],
  ]
  for (const [label, character] of hostile) {
    assert.equal(titleFrom(`/root/left${character}right`), "leftright", label)
    assertSafeTitle(titleFrom(`/root/left${character}right`), label)
  }

  for (const payload of ["<script>alert(1)</script>", "${jndi:ldap://invalid}", "`touch /tmp/nope`"]) {
    assert.equal(sanitizeTabTitle(payload), payload, "inert text must not be executed or rewritten")
  }
  assert.equal(titleFrom("C:\\root\\\u001b[2J\u001b[31m"), "[2J[31m")
  assert.equal(titleFrom("/root/\u202e\u2066\u200b"), "Project")
  assert.equal(sanitizeTabTitle("  safe\nname  "), "safename")
})

test("brutal/symbols: every Unicode code point is safe in a tab title", { timeout: 60_000 }, () => {
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
    const symbol = String.fromCodePoint(codePoint)
    const title = titleFrom(`/root/left${symbol}right`)
    const unsafe = firstUnsafeCodePoint(title)
    if (
      unsafe !== undefined ||
      Array.from(title).length > MAX_TAB_TITLE_LENGTH ||
      title.includes("/") ||
      title.includes("\\")
    ) {
      assert.fail(`unsafe result for input U+${codePoint.toString(16)}`)
    }
  }
})

test("brutal/symbols: 50,000 randomized paths and multi-megabyte inputs stay bounded", { timeout: 60_000 }, () => {
  const alphabet = [
    "a",
    " ",
    ".",
    ":",
    "\\",
    "/",
    "п",
    "漢",
    "🚀",
    "👩\u200d💻",
    "e\u0301",
    "\u0000",
    "\n",
    "\u001b",
    "\u202e",
    "\u2066",
    "\u200d",
    "\u200c",
    "\u200b",
    "\ufeff",
    "\ud800",
    "\udfff",
    "\u{E0067}",
    "\u{10FFFF}",
  ]
  let state = 0x9e3779b9
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }

  for (let index = 0; index < 50_000; index++) {
    const length = Math.floor(random() * 300)
    let path = "/root/"
    for (let char = 0; char < length; char++) {
      path += alphabet[Math.floor(random() * alphabet.length)]
    }
    assertSafeTitle(titleFrom(path), `random path ${index}`)
  }

  const hugeInputs = [
    `/root/${"\u001b\u202e\u200b".repeat(300_000)}safe`,
    `/root/${"🚀".repeat(500_000)}`,
    `/root/${"x".repeat(2_000_000)}`,
    `/root/${"\ud800".repeat(500_000)}safe`,
  ]
  for (const [index, input] of hugeInputs.entries()) {
    assertSafeTitle(titleFrom(input), `huge input ${index}`)
  }
})

test("brutal/failures: synchronous throw storm is isolated per session", async () => {
  const sessions: SessionInfo[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: `ses_SYNC_${index}`,
    title: `Old\u202e${index}`,
  }))
  let expectedFailures = 0
  const originalError = console.error
  const logs: string[] = []
  console.error = (...parts: unknown[]) => logs.push(parts.join(" "))

  const ctx: PluginContext = {
    location: {
      directory: "C:\\private\\checkout",
      project: {
        id: "sync-storm",
        directory: "C:\\private\\checkout",
        canonical: "C:\\private\\project",
      },
    },
    session: {
      async hook() {},
      list(input): Promise<any> {
        const offset = input.cursor ? Number(input.cursor.split(":")[0]) : 0
        return Promise.resolve({
          data: sessions.slice(offset, offset + 100),
          cursor:
            offset + 100 < sessions.length
              ? { next: `${offset + 100}:PRIVATE_CURSOR\u202e` }
              : {},
        })
      },
      update(input): Promise<void> {
        const index = Number(input.sessionID.slice(9))
        if (index % 2 === 0) {
          expectedFailures++
          throw new Error(`PRIVATE_SYNC_FAILURE_${index}`)
        }
        return Promise.resolve()
      },
    },
    event: {
      subscribe() {
        return (async function* () {})()
      },
    },
  }

  try {
    const stats = await syncExistingSessions(ctx)
    assert.equal(stats.pages, 100)
    assert.equal(stats.failed, expectedFailures)
    assert.equal(stats.renamed, 10_000 - expectedFailures)
  } finally {
    console.error = originalError
  }

  assert.equal(expectedFailures, 5_000)
  assert.ok(logs.length > 0)
  assert.ok(logs.every((line) => !line.includes("PRIVATE") && !line.includes("ses_")))
})

test("brutal/privacy: hostile metadata and failures cannot reach logs, streams or network", { timeout: 60_000 }, async () => {
  const secrets = [
    "PRIVATE_SESSION",
    "PRIVATE_CURSOR",
    "PRIVATE_PATH",
    "PRIVATE_ERROR",
    "PRIVATE_STREAM",
    "TEST_TOKEN_NOT_A_SECRET",
    "пароль-не-писать",
    "秘密",
    "🚀SECRET",
    "\u001b[2J",
    "\u202e",
  ]
  const consoleCalls: unknown[][] = []
  let directOutput = ""
  let warnings = 0
  let networkCalls = 0
  let stringifyAttempts = 0
  const updates: Array<{ sessionID: string; title: string }> = []

  const originalConsole = {
    error: console.error,
    warn: console.warn,
    log: console.log,
    info: console.info,
    debug: console.debug,
    trace: console.trace,
  }
  const originalStdout = process.stdout.write
  const originalStderr = process.stderr.write
  const originalWarning = process.emitWarning
  const originalFetch = globalThis.fetch
  const originalWebSocket = globalThis.WebSocket

  const captureConsole = (...parts: unknown[]) => consoleCalls.push(parts)
  console.error = captureConsole
  console.warn = captureConsole
  console.log = captureConsole
  console.info = captureConsole
  console.debug = captureConsole
  console.trace = captureConsole
  const captureWrite = (chunk: string | Uint8Array, ...args: unknown[]): boolean => {
    directOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    const callback = args.find((part) => typeof part === "function") as (() => void) | undefined
    callback?.()
    return true
  }
  process.stdout.write = captureWrite as typeof process.stdout.write
  process.stderr.write = captureWrite as typeof process.stderr.write
  process.emitWarning = (() => {
    warnings++
  }) as typeof process.emitWarning
  globalThis.fetch = (() => {
    networkCalls++
    throw new Error("unexpected network")
  }) as typeof fetch
  globalThis.WebSocket = class {
    constructor() {
      networkCalls++
      throw new Error("unexpected websocket")
    }
  } as unknown as typeof WebSocket

  const hostileError = () => ({
    message: "PRIVATE_ERROR TEST_TOKEN_NOT_A_SECRET",
    stack: "PRIVATE_PATH C:\\private\\project",
    toString() {
      stringifyAttempts++
      return "PRIVATE_ERROR_TO_STRING"
    },
  })

  const ctx: PluginContext = {
    location: {
      directory: "C:\\PRIVATE_PATH\\checkout",
      project: {
        id: "project-privacy",
        directory: "C:\\PRIVATE_PATH\\checkout",
        canonical: "C:\\PRIVATE_PATH\\безопасный-проект",
      },
    },
    session: {
      async hook() {},
      list(input): Promise<any> {
        const page = input.cursor ? Number(input.cursor.split(":")[0]) : 0
        if (page >= 20) return Promise.reject(hostileError())
        const data = Array.from({ length: 100 }, (_, index) => ({
          id: `ses_PRIVATE_SESSION_${page * 100 + index}`,
          title: `пароль-не-писать \u001b[2J ${index}`,
          prompt: "秘密",
        }))
        return Promise.resolve({
          data,
          cursor: { next: `${page + 1}:PRIVATE_CURSOR\u202e` },
        })
      },
      update(input): Promise<void> {
        updates.push(input)
        const index = Number(input.sessionID.split("_").at(-1))
        if (index % 3 === 0) return Promise.reject(hostileError())
        if (index % 5 === 0) throw hostileError()
        return Promise.resolve()
      },
    },
    event: {
      subscribe() {
        return (async function* (): AsyncGenerator<CreatedSessionEvent> {
          for (let index = 0; index < 5_000; index++) {
            yield {
              type: index % 7 === 0 ? "message.updated" : "session.created",
              data: {
                sessionID: `ses_PRIVATE_SESSION_${index + 10_000}`,
                projectID: index % 11 === 0 ? "another-project" : "project-privacy",
                title: "🚀SECRET \u202e",
              },
              prompt: "пароль-не-писать",
              messages: [{ content: "TEST_TOKEN_NOT_A_SECRET" }],
            } as CreatedSessionEvent
          }
          throw hostileError()
        })()
      },
    },
  }

  try {
    await syncExistingSessions(ctx)
    await watchCreatedSessions(ctx, "безопасный-проект", new AbortController().signal)
  } finally {
    console.error = originalConsole.error
    console.warn = originalConsole.warn
    console.log = originalConsole.log
    console.info = originalConsole.info
    console.debug = originalConsole.debug
    console.trace = originalConsole.trace
    process.stdout.write = originalStdout
    process.stderr.write = originalStderr
    process.emitWarning = originalWarning
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalWebSocket
  }

  assert.ok(consoleCalls.length > 100)
  assert.ok(consoleCalls.every((parts) => parts.length === 1 && typeof parts[0] === "string"))
  const output = consoleCalls.map(([message]) => message as string).join("\n")
  assert.ok(
    output.split("\n").every((line) =>
      /^\[project-folder-tabs\] (?:could not list sessions|could not rename \d+ session\(s\)|stopped a repeated pagination cursor|could not rename new session|session event stream stopped|initial synchronization stopped|title hook unavailable|session event stream unavailable|synchronization API unavailable|plugin context unavailable|synchronization page limit reached|session event stream cleanup failed)$/.test(line),
    ),
    "a non-generic message was logged",
  )
  for (const secret of secrets) {
    assert.ok(!output.includes(secret), "a secret reached console output")
    assert.ok(!directOutput.includes(secret), "a secret reached a process stream")
  }
  assert.ok(output.split("\n").every((line) => firstUnsafeCodePoint(line) === undefined))
  assert.equal(directOutput, "")
  assert.equal(warnings, 0)
  assert.equal(networkCalls, 0)
  assert.equal(stringifyAttempts, 0, "an error object was inspected")
  assert.ok(updates.length > 5_000)
  assert.ok(
    updates.every(
      (update) =>
        update.title === "безопасный-проект" &&
        !update.title.includes("PRIVATE_PATH") &&
        Object.keys(update).sort().join(",") === "sessionID,title",
    ),
  )
})

test("brutal/cleanup: 500 abort cycles close streams and pre-aborted setups do no work", async () => {
  let active = 0
  let closed = 0
  let updates = 0
  let subscriptions = 0

  for (let cycle = 0; cycle < 500; cycle++) {
    let signal: AbortSignal | undefined
    const ctx: PluginContext = {
      location: {
        directory: "C:\\stress\\checkout",
        project: {
          id: "cleanup",
          directory: "C:\\stress\\checkout",
          canonical: "C:\\stress\\project",
        },
      },
      session: {
        async hook() {},
        async list() {
          return { data: [] }
        },
        async update() {
          updates++
        },
      },
      event: {
        subscribe(options) {
          signal = options.signal
          subscriptions++
          active++
          return (async function* (): AsyncGenerator<CreatedSessionEvent> {
            try {
              await new Promise<void>((resolve) => {
                if (options.signal.aborted) resolve()
                else options.signal.addEventListener("abort", () => resolve(), { once: true })
              })
              // Deliberately ignore cancellation to prove the watcher checks it too.
              for (let index = 0; index < 10_000; index++) {
                yield {
                  type: "session.created",
                  data: { sessionID: `ses_${index}`, projectID: "cleanup", title: "old" },
                }
              }
            } finally {
              active--
              closed++
            }
          })()
        },
      },
    }

    const cleanup = await setupProjectFolderTabs(ctx)
    cleanup()
    cleanup()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(signal?.aborted, true)
  }

  assert.equal(active, 0)
  assert.equal(closed, 500)
  assert.equal(updates, 0)

  const alreadyAborted = AbortSignal.abort()
  await watchCreatedSessions(ctxForPreAborted(), "project", alreadyAborted)
  assert.equal(subscriptions, 500)

  function ctxForPreAborted(): PluginContext {
    return {
      location: {
        directory: "C:\\stress\\checkout",
        project: { id: "cleanup", directory: "C:\\stress\\checkout", canonical: "C:\\stress\\project" },
      },
      session: {
        async hook() {},
        async list() {
          return { data: [] }
        },
        async update() {
          updates++
        },
      },
      event: {
        subscribe() {
          subscriptions++
          return (async function* () {})()
        },
      },
    }
  }
})

test("brutal/privacy: runtime source has no hidden I/O or unapproved dependencies", async () => {
  const [core, entry, manifestText] = await Promise.all([
    readFile(new URL("../core.ts", import.meta.url), "utf8"),
    readFile(new URL("../index.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ])
  const manifest = JSON.parse(manifestText)

  assert.deepEqual(manifest.dependencies, { "@opencode/plugin": "latest" })
  assert.doesNotMatch(core, /(?:^|\n)\s*import\s/)
  assert.doesNotMatch(
    core,
    /\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|\bEventSource\b|node:(?:fs|http|https|net|tls|child_process)|\beval\s*\(|new\s+Function|process\.env|localStorage/,
  )
  const imports = [...entry.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])
  assert.deepEqual(imports.sort(), ["./core.ts", "@opencode/plugin"])
})
