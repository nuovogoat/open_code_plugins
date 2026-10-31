import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { relative, resolve, join } from "node:path"

const cli = process.env.OPENCODE_CLI
if (!cli) throw new Error("Set OPENCODE_CLI to the OpenCode CLI executable")

const pluginRoot = resolve(import.meta.dirname, "..")
const results = resolve(pluginRoot, "test-results")
await mkdir(results, { recursive: true })
const directory = await mkdtemp(join(results, "live-project-"))
const packagePath = relative(directory, pluginRoot).replaceAll("\\", "/")
await writeFile(
  join(directory, "opencode.json"),
  JSON.stringify({
    plugins: [{ package: packagePath, options: { rescanIntervalMs: 600_000 } }],
  }),
)

const password = "model-router-live"
let serverOutput = ""
let server: ReturnType<typeof spawn> | undefined
const serverURL = await new Promise<string>((resolveStart, rejectStart) => {
  let settled = false
  const fail = (error: Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    server?.kill()
    rejectStart(error)
  }
  const timer = setTimeout(() => fail(new Error(`opencode serve timed out: ${serverOutput}`)), 30_000)
  server = spawn(cli!, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    windowsHide: true,
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const inspect = (chunk: unknown) => {
    if (settled) return
    serverOutput += String(chunk)
    if (serverOutput.length > 1_000_000) {
      fail(new Error("opencode serve output limit exceeded"))
      return
    }
    const match = serverOutput.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/iu)
    if (!match) return
    settled = true
    clearTimeout(timer)
    resolveStart(match[0])
  }
  server.stdout!.setEncoding("utf8")
  server.stderr!.setEncoding("utf8")
  server.stdout!.on("data", inspect)
  server.stderr!.on("data", inspect)
  server.on("error", (error) => fail(error))
  server.on("exit", (code) => {
    if (!settled) fail(new Error(`opencode serve exited (${code}): ${serverOutput}`))
  })
})

function run(args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(cli!, ["--server", serverURL, ...args], {
      windowsHide: true,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let failure: Error | undefined
    const stop = (message: string) => {
      failure ??= new Error(message)
      child.kill()
    }
    const timer = setTimeout(() => stop(`opencode ${args[0]} timed out`), 30_000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (stdout.length + stderr.length > 4_000_000) stop("CLI output limit exceeded")
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      if (stdout.length + stderr.length > 4_000_000) stop("CLI output limit exceeded")
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (code === 0) resolveOutput(stdout.trim())
      else reject(new Error(`opencode ${args.join(" ")} failed (${code}): ${stderr || stdout}`))
    })
  })
}

async function api(
  operation: string,
  options: { params?: Record<string, string>; data?: unknown } = {},
): Promise<any> {
  const args = ["api", operation]
  for (const [key, value] of Object.entries(options.params ?? {})) {
    args.push("--param", `${key}=${value}`)
  }
  if (options.data !== undefined) args.push("--data", JSON.stringify(options.data))
  const output = await run(args)
  const result = output ? JSON.parse(output) : undefined
  if (result?._tag) throw new Error(`${operation}: ${JSON.stringify(result)}`)
  return result
}

const location = `location%5Bdirectory%5D=${encodeURIComponent(directory)}`
async function call(method: string, input: unknown = {}): Promise<any> {
  const output = await run([
    "api",
    "post",
    `/api/rpc/opencode-model-autorouter/${method}?${location}`,
    "--data",
    JSON.stringify({ input }),
  ])
  const result = output ? JSON.parse(output) : undefined
  if (result?._tag) throw new Error(`${method}: ${JSON.stringify(result)}`)
  return result?.output
}

async function eventually<T>(callback: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await callback()
    } catch (error) {
      lastError = error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
    }
  }
  throw lastError instanceof Error ? lastError : new Error("live condition was not reached")
}

let sessionID: string | undefined
try {
  const created = await api("session.create", {
    data: { title: `__model_router_live_${Date.now()}__`, location: { directory } },
  })
  sessionID = created.data.id

  await eventually(async () => {
    const plugins = JSON.parse(await run(["api", "get", `/api/plugin?${location}`]))
    const plugin = plugins.data?.find?.((item: any) => item.id === "opencode-model-autorouter")
    assert.equal(plugin?.state?.status, "active", JSON.stringify(plugin ?? plugins))
    assert.equal(plugin?.features?.gui, true, JSON.stringify(plugin))
  })
  const gui = JSON.parse(
    await run([
      "api",
      "get",
      `/api/plugin/gui?id=opencode-model-autorouter&${location}`,
    ]),
  )
  assert.ok(gui.data.code.includes("Model Autorouter"))
  assert.ok(gui.data.revision)

  await eventually(async () => {
    const value = await call("status")
    assert.equal(value.enabled, true)
  })
  const status = await eventually(async () => {
    const value = await call("rescan")
    assert.equal(value.enabled, true)
    assert.equal(value.autoDiscover, true)
    assert.ok(value.modelsDiscovered > 0)
    assert.ok(value.groups.length > 0, "connected live providers have no equivalent model IDs")
    for (const providerID of ["teamorouter", "plusvibe"]) {
      const account = value.accounts.find((item: any) => item.providerID === providerID)
      assert.equal(account?.state, "live", JSON.stringify(value.accounts))
      assert.ok(account?.matchedModels > 0, `${providerID} account prices matched no catalog models`)
      assert.equal(typeof account?.balance, "number", `${providerID} returned no account balance`)
      assert.ok(account?.updatedAt, `${providerID} snapshot has no timestamp`)
      // No vault key is configured in the live run, so credentials come from OpenCode.
      assert.equal(account?.keySource, "opencode", `${providerID} reported an unexpected key source`)
      assert.equal(account?.pluginKey, undefined, `${providerID} claims a plugin vault key`)
    }
    return value
  })
  assert.equal(status.models.length, status.modelsDiscovered)
  const accounts = new Map<string, any>(
    status.accounts.map((account: any) => [account.providerID, account]),
  )
  assert.equal(accounts.get("teamorouter").balanceCurrency, "USD")
  assert.equal(accounts.get("plusvibe").balanceCurrency, "RUB")
  if (accounts.has("apimaster")) assert.equal(accounts.get("apimaster").state, "unsupported")
  // Every displayed price comes from a confirmed source (account tariff or
  // public listing) and carries its currency.
  assert.ok(
    status.models.every((model: any) =>
      model.cost === undefined ||
      (typeof model.costCurrency === "string" &&
        ["live", "stale", "public", "public-stale"].includes(model.priceState)),
    ),
  )
  for (const [providerID, account] of accounts) {
    const matched = status.models.filter(
      (model: any) =>
        model.providerID === providerID &&
        (model.priceState === "live" || model.priceState === "stale"),
    ).length
    assert.equal(account.matchedModels, matched, `${providerID} matched-model count is inconsistent`)
  }
  assert.ok(
    status.models.some((model: any) => model.providerID === "plusvibe" && model.costCurrency === "RUB"),
    "plusvibe ruble account prices are missing",
  )
  assert.ok(
    status.models.every(
      (model: any) =>
        typeof model.providerID === "string" &&
        typeof model.id === "string" &&
        typeof model.routingEnabled === "boolean" &&
        typeof model.free === "boolean",
    ),
  )
  assert.ok(
    status.groups.every((group: any) =>
      group.candidates.every((candidate: any) => typeof candidate.model === "string"),
    ),
  )
  const serialized = JSON.stringify(status)
  assert.equal(serialized.includes(directory), false)
  assert.equal(serialized.includes("__model_router_live"), false)
  // Account keys are resolved server-side and must never reach RPC output.
  for (const name of ["TEAMOROUTER_API_KEY", "PLUSVIBE_API_KEY", "APIMASTER_API_KEY", "OPENROUTER_API_KEY"]) {
    const secret = process.env[name]
    if (secret) assert.equal(serialized.includes(secret), false, `${name} leaked into status`)
  }

  // Vault RPC methods are registered on the real server and reject invalid input
  // without storing anything; clearing an absent key is a safe no-op.
  await assert.rejects(
    call("setAccountKey", { providerID: "apimaster", key: "x" }),
    /setAccountKey/u,
  )
  await assert.rejects(
    call("setAccountKey", { providerID: "plusvibe", key: "" }),
    /setAccountKey/u,
  )
  assert.deepEqual(await call("clearAccountKey", { providerID: "openrouter" }), { cleared: false })

  // Threshold monitoring accepts real configuration and clears cleanly; the huge
  // minimum can only produce a «warn» mark because the action stays non-excluding.
  const withThresholds = await call("configure", {
    accountThresholds: { plusvibe: { minBalance: 1_000_000, action: "warn" } },
  })
  assert.deepEqual(withThresholds.accountThresholds.plusvibe, {
    minBalance: 1_000_000,
    action: "warn",
  })
  const thresholdAccount = withThresholds.accounts.find(
    (item: any) => item.providerID === "plusvibe",
  )
  if (thresholdAccount?.balance !== undefined) {
    assert.equal(thresholdAccount.lowBalance, true)
  }
  assert.ok(
    withThresholds.models.every((item: any) => item.thresholdExcluded === undefined),
    "warn action must never exclude models",
  )
  const withoutThresholds = await call("configure", { accountThresholds: {} })
  assert.deepEqual(withoutThresholds.accountThresholds, {})
  assert.ok(withoutThresholds.accounts.every((item: any) => item.lowBalance === undefined))

  // Global price limits: an impossibly low RUB maximum can only «warn» because
  // the action stays non-excluding; every RUB-priced model with a confirmed
  // account tariff must be flagged, and no other currency may be affected.
  const withLimits = await call("configure", {
    priceLimits: { RUB: { inputMax: 0.000001, action: "warn" } },
  })
  assert.deepEqual(withLimits.priceLimits.RUB, { inputMax: 0.000001, action: "warn" })
  const rubModels = withLimits.models.filter(
    (item: any) => item.costCurrency === "RUB" && item.priceState !== undefined,
  )
  if (rubModels.length > 0) {
    assert.ok(
      rubModels.every((item: any) => item.priceLimitBreached === true),
      "every confirmed RUB price exceeds the 0.000001 bound",
    )
  }
  assert.ok(
    withLimits.models.every(
      (item: any) => item.costCurrency === "RUB" || item.priceLimitBreached === undefined,
    ),
    "RUB limits must never flag other currencies",
  )
  assert.ok(
    withLimits.models.every((item: any) => item.thresholdExcluded === undefined),
    "warn action must never exclude models",
  )
  const withoutLimits = await call("configure", { priceLimits: {} })
  assert.deepEqual(withoutLimits.priceLimits, {})
  assert.ok(
    withoutLimits.models.every((item: any) => item.priceLimitBreached === undefined),
    "cleared limits remove all price marks",
  )

  // Public price discovery needs no account at all: the OpenRouter listing is
  // published on the provider site. The site may be unreachable from this
  // network, so absence is tolerated, but a present snapshot must be valid.
  const withSites = await call("configure", {
    providerSites: { openrouter: "https://openrouter.ai" },
  })
  assert.deepEqual(withSites.providerSites, { openrouter: "https://openrouter.ai" })
  const publicInfo = withSites.publicPricing.find(
    (item: any) => item.providerID === "openrouter",
  )
  if (publicInfo) {
    assert.equal(publicInfo.state, "live")
    assert.ok(
      publicInfo.origin.startsWith("https://openrouter.ai/"),
      `unexpected discovery origin: ${publicInfo.origin}`,
    )
    assert.ok(publicInfo.matchedModels > 0, "public listing matched no catalog models")
    const publicModels = withSites.models.filter(
      (item: any) =>
        item.providerID === "openrouter" &&
        (item.priceState === "public" || item.priceState === "public-stale"),
    )
    assert.equal(publicModels.length, publicInfo.matchedModels)
    assert.ok(
      publicModels.every((item: any) => item.costCurrency === "USD"),
      "the OpenRouter public listing publishes USD prices",
    )
  }

  // Real end-to-end discovery against a loopback listing: the plugin must find
  // prices published on the provider site without any account or credentials.
  let loopbackSummary: unknown = "skipped"
  const listing: { data: Array<Record<string, unknown>> } = { data: [] }
  const http = await import("node:http")
  const localServer = http.createServer((_request, response) => {
    const body = JSON.stringify(listing)
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    })
    response.end(body)
  })
  await new Promise<void>((resolveListen) =>
    localServer.listen(0, "127.0.0.1", resolveListen),
  )
  const port = (localServer.address() as import("node:net").AddressInfo).port
  try {
    const unpriced = withSites.models.find((item: any) => item.priceState === undefined)
    assert.ok(unpriced, "the live catalog has no unpriced model for loopback discovery")
    listing.data = [
      { id: unpriced.id, pricing: { prompt: "0.000001", completion: "0.000002" } },
    ]
    const site = `http://127.0.0.1:${port}`
    const loopback = await call("configure", {
      providerSites: { [unpriced.providerID]: site },
    })
    assert.deepEqual(loopback.providerSites, { [unpriced.providerID]: site })
    const info = loopback.publicPricing.find(
      (item: any) => item.providerID === unpriced.providerID,
    )
    assert.ok(info, "loopback discovery produced no snapshot")
    assert.equal(info.state, "live")
    assert.equal(info.origin, `${site}/v1/models`)
    assert.ok(info.matchedModels >= 1)
    const discovered = loopback.models.find((item: any) => item.model === unpriced.model)
    assert.equal(discovered.priceState, "public")
    assert.equal(discovered.costCurrency, "USD")
    assert.equal(discovered.cost[0].input, 1)
    assert.equal(discovered.cost[0].output, 2)
    loopbackSummary = {
      providerID: unpriced.providerID,
      model: unpriced.model,
      origin: info.origin,
      matchedModels: info.matchedModels,
    }
  } finally {
    await new Promise<void>((resolveClose) => localServer.close(() => resolveClose()))
  }
  // An invalid address is dropped by normalization instead of being stored.
  const badSites = await call("configure", {
    providerSites: { openrouter: "http://evil.example" },
  })
  assert.deepEqual(badSites.providerSites, {})
  // Clearing sites drops every snapshot and every public price with it.
  const withoutSites = await call("configure", { providerSites: {} })
  assert.deepEqual(withoutSites.providerSites, {})
  assert.deepEqual(withoutSites.publicPricing, [])
  assert.ok(
    withoutSites.models.every(
      (item: any) =>
        item.priceState === undefined ||
        item.priceState === "live" ||
        item.priceState === "stale",
    ),
    "clearing sites removes every public price",
  )

  // ЦБ РФ orientation is opt-in; the public feed may be unreachable from this
  // network, so either absence or a fully valid rate set is accepted.
  const oriented = await call("configure", { cbrOrientation: true })
  assert.equal(oriented.cbrOrientation, true)
  if (oriented.cbr) {
    assert.match(oriented.cbr.date, /^\d{2}\.\d{2}\.\d{4}$/u)
    assert.equal(oriented.cbr.rates.RUB, 1)
    assert.equal(typeof oriented.cbr.rates.USD, "number")
    assert.ok(oriented.cbr.rates.USD > 0)
    assert.equal(typeof oriented.cbr.stale, "boolean")
  }
  const unoriented = await call("configure", { cbrOrientation: false })
  assert.equal(unoriented.cbr, undefined)
  assert.equal(unoriented.cbrOrientation, false)
  const resetStatus = await call("configure", { reset: true })
  assert.equal(resetStatus.cbr, undefined)
  assert.deepEqual(resetStatus.accountThresholds, {})
  assert.deepEqual(resetStatus.priceLimits, {})
  assert.deepEqual(resetStatus.providerSites, {})

  const candidate = status.groups[0].candidates[0].model
  const selected = await call("select", { sessionID, model: candidate })
  assert.equal(selected.selected, candidate)
  const session = await api("session.get", { params: { sessionID: sessionID! } })
  assert.equal(session.data.model.providerID, candidate.split("/")[0])

  const singleton = status.models.find(
    (model: any) => model.groups.length === 0 && model.routingEnabled,
  )
  if (singleton) {
    const direct = await call("select", { sessionID, model: singleton.model })
    assert.equal(direct.selected, singleton.model)
  }

  console.log(
    JSON.stringify({
      plugin: "active",
      guiRevision: gui.data.revision,
      modelsDiscovered: status.modelsDiscovered,
      automaticGroups: status.groups.filter((group: any) => group.automatic).length,
      accounts: status.accounts.map((account: any) => ({
        providerID: account.providerID,
        state: account.state,
        matchedModels: account.matchedModels,
        balance: account.balance,
        balanceCurrency: account.balanceCurrency,
      })),
      manualGroups: status.groups.filter((group: any) => !group.automatic).length,
      singletonSelected: singleton?.model,
      selected,
      thresholdsChecked: true,
      publicPricing: publicInfo
        ? {
            providerID: publicInfo.providerID,
            origin: publicInfo.origin,
            state: publicInfo.state,
            matchedModels: publicInfo.matchedModels,
          }
        : "openrouter.ai unreachable from this network",
      loopbackDiscovery: loopbackSummary,
      cbrOrientation: oriented.cbr
        ? { date: oriented.cbr.date, usd: oriented.cbr.rates.USD, stale: oriented.cbr.stale }
        : "feed unreachable from this network",
      promptsSent: 0,
    }),
  )
} finally {
  let cleanupFailed = false
  if (sessionID) {
    try {
      await api("session.remove", { params: { sessionID } })
    } catch {
      cleanupFailed = true
    }
  }
  try {
    await rm(directory, { recursive: true, force: true })
  } catch {
    cleanupFailed = true
  }
  if (server?.exitCode === null) {
    const stopped = new Promise<void>((resolveStop) => {
      server!.once("exit", () => resolveStop())
      server!.kill()
      setTimeout(resolveStop, 5_000).unref()
    })
    await stopped
  }
  if (cleanupFailed) process.exitCode = 1
}
