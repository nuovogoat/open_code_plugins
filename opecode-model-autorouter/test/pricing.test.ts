import assert from "node:assert/strict"
import test from "node:test"
import {
  loadAccountSnapshots,
  parseOpenRouterCreditsBalance,
  parseOpenRouterKeyBalance,
  parseOpenRouterModels,
  parsePlusVibeBalance,
  parsePlusVibeModels,
  parseTeamoRouterBalance,
  parseTeamoRouterModels,
  withAccountPricing,
  type AccountSnapshot,
} from "../pricing.ts"

const openRouterPayload = {
  data: [
    {
      id: "openai/gpt-4o",
      pricing: {
        prompt: "0.0000025",
        completion: "0.00001",
        input_cache_read: "0.00000125",
        input_cache_write: "0",
      },
    },
    { id: "broken", pricing: { prompt: "-1", completion: "0.00001" } },
    { id: "missing" },
  ],
}

test("pricing: openrouter per-token strings become USD per million tokens", () => {
  const costs = parseOpenRouterModels(openRouterPayload)
  assert.deepEqual([...costs.keys()], ["openai/gpt-4o"])
  assert.deepEqual(costs.get("openai/gpt-4o"), {
    currency: "USD",
    cost: [{ input: 2.5, output: 10, cache: { read: 1.25, write: 0 } }],
  })
  assert.deepEqual([...parseOpenRouterModels({}).keys()], [])
})

test("pricing: openrouter balances come from key limits or purchased credits", () => {
  assert.deepEqual(parseOpenRouterKeyBalance({ data: { limit_remaining: "12.5" } }), {
    amount: 12.5,
    currency: "USD",
  })
  assert.equal(parseOpenRouterKeyBalance({ data: { limit: "none" } }), undefined)
  assert.deepEqual(parseOpenRouterCreditsBalance({ data: { total_credits: 100, total_usage: 40 } }), {
    amount: 60,
    currency: "USD",
  })
  assert.equal(parseOpenRouterCreditsBalance({ data: { total_credits: 100 } }), undefined)
})

const teamoRouterPayload = {
  models: {
    providers: {
      anthropic: {
        apiKey: "secret-must-not-leak",
        models: [
          { id: "claude-haiku", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
          { id: "broken", cost: { input: -2, output: 5 } },
        ],
      },
      google: { models: [{ id: "gemini-flash", cost: { input: 0.3, output: 2.5 } }] },
    },
  },
}

test("pricing: teamorouter nested provider costs keep only model IDs and USD prices", () => {
  const costs = parseTeamoRouterModels(teamoRouterPayload)
  assert.deepEqual(costs.get("claude-haiku"), {
    currency: "USD",
    cost: [{ input: 1, output: 5, cache: { read: 0.1, write: 1.25 } }],
  })
  assert.deepEqual(costs.get("gemini-flash"), {
    currency: "USD",
    cost: [{ input: 0.3, output: 2.5, cache: { read: 0, write: 0 } }],
  })
  assert.equal(costs.has("broken"), false)
  for (const value of costs.values()) {
    assert.equal(JSON.stringify(value).includes("secret-must-not-leak"), false)
  }
})

test("pricing: teamorouter balance accepts numeric strings and keeps the account currency", () => {
  assert.deepEqual(
    parseTeamoRouterBalance({ data: { available_balance: "9.83", currency: "USD" } }),
    { amount: 9.83, currency: "USD" },
  )
  assert.deepEqual(
    parseTeamoRouterBalance({ data: { availableBalance: 4.2, currency: "usd" } }),
    { amount: 4.2, currency: "USD" },
  )
  assert.equal(parseTeamoRouterBalance({ data: { status: "ACTIVE" } }), undefined)
})

const plusVibePayload = {
  object: "list",
  currency: "RUB",
  data: [
    {
      model: "claude-opus",
      variants: [
        {
          addressAs: "anthropic/claude-opus",
          inputRub: 123,
          outputRub: 615,
          cacheReadRub: 12,
          cacheWriteRub: 154,
          isDefault: true,
        },
        {
          addressAs: "anthropic/claude-opus:alias",
          inputRub: 151,
          outputRub: 750,
          cacheReadRub: 15,
          cacheWriteRub: 189,
          isDefault: false,
        },
      ],
    },
    { model: "no-default", variants: [{ addressAs: "x/y", inputRub: 1, outputRub: 2 }] },
    { model: "broken", variants: [{ inputRub: -5, outputRub: 2, isDefault: true }] },
  ],
}

test("pricing: plusvibe maps only declared default variants in the root currency", () => {
  const costs = parsePlusVibeModels(plusVibePayload)
  assert.deepEqual([...costs.keys()], ["claude-opus"])
  assert.deepEqual(costs.get("claude-opus"), {
    currency: "RUB",
    cost: [{ input: 123, output: 615, cache: { read: 12, write: 154 } }],
  })
  assert.deepEqual([...parsePlusVibeModels({ data: [] }).keys()], [])
  assert.deepEqual([...parsePlusVibeModels({}).keys()], [])
})

test("pricing: plusvibe balance keeps the ruble amount and currency", () => {
  assert.deepEqual(parsePlusVibeBalance({ balance: 168.25, currency: "RUB", balance_rub: 168.25 }), {
    amount: 168.25,
    currency: "RUB",
  })
  assert.equal(parsePlusVibeBalance({ currency: "RUB" }), undefined)
})

test("pricing: account costs replace native snapshots and unmatched models get no price", () => {
  interface TestModel {
    providerID: string
    id: string
    cost?: Array<{ input: number; output: number }>
    costCurrency?: string
    priceState?: "live" | "stale"
  }
  const models: TestModel[] = [
    { providerID: "teamorouter", id: "claude-haiku", cost: [{ input: 99, output: 99 }] },
    { providerID: "apimaster", id: "unknown", cost: [{ input: 3, output: 4 }] },
  ]
  const snapshots = new Map<string, AccountSnapshot>([
    ["teamorouter", {
      providerID: "teamorouter",
      state: "live",
      updatedAt: 1,
      costs: parseTeamoRouterModels(teamoRouterPayload),
      pricingSupported: true,
      balanceSupported: true,
    }],
    ["apimaster", {
      providerID: "apimaster",
      state: "unsupported",
      costs: new Map(),
      pricingSupported: false,
      balanceSupported: false,
    }],
  ])
  const merged = withAccountPricing(models, snapshots)
  assert.equal(merged[0].cost?.[0].input, 1)
  assert.equal(merged[0].costCurrency, "USD")
  assert.equal(merged[0].priceState, "live")
  // Unsupported accounts and unmatched models deliberately have no fabricated price.
  assert.equal(merged[1].cost, undefined)
  assert.equal(merged[1].costCurrency, undefined)
  assert.equal(models[0].cost![0].input, 99)
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function fetcher(routes: Record<string, unknown>, requests: Array<{ url: string; init?: RequestInit }>) {
  return (async (url: unknown, init?: RequestInit) => {
    const href = String(url)
    requests.push({ url: href, init })
    const body = routes[href]
    return body === undefined ? jsonResponse({ error: "unknown_endpoint" }, 404) : jsonResponse(body)
  }) as typeof fetch
}

const TEAMO_BALANCE = { data: { available_balance: "9.8", currency: "USD" } }
const PLUSVIBE_BALANCE = { balance: 168.25, currency: "RUB" }

test("accounts: supported providers load live snapshots over their fixed API origins", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const snapshots = await loadAccountSnapshots(
    fetcher({
      "https://api.teamorouter.com/v1/models/config": teamoRouterPayload,
      "https://api.teamorouter.com/v1/billing/me/balance": TEAMO_BALANCE,
      "https://plusvibeapi.ru/v1/pricing": plusVibePayload,
      "https://plusvibeapi.ru/v1/balance": PLUSVIBE_BALANCE,
    }, requests),
    new AbortController().signal,
    [
      { id: "teamorouter", integrationID: "teamorouter" },
      { id: "plusvibe" },
    ],
    async (integrationID) => `key-for-${integrationID}`,
  )
  const byProvider = new Map(snapshots.map((snapshot) => [snapshot.providerID, snapshot]))
  assert.equal(byProvider.get("teamorouter")?.state, "live")
  assert.deepEqual(byProvider.get("teamorouter")?.balance, { amount: 9.8, currency: "USD" })
  assert.equal(byProvider.get("teamorouter")?.costs.get("claude-haiku")?.cost[0].input, 1)
  assert.equal(byProvider.get("plusvibe")?.state, "live")
  assert.deepEqual(byProvider.get("plusvibe")?.balance, { amount: 168.25, currency: "RUB" })
  assert.equal(byProvider.get("plusvibe")?.costs.get("claude-opus")?.currency, "RUB")
  assert.equal(byProvider.get("plusvibe")?.pricingSupported, true)
  // The resolved credential only travels to the hardcoded account API origin.
  const sent = JSON.stringify(snapshots)
  assert.equal(sent.includes("key-for-"), false)
  for (const request of requests) {
    assert.match(request.url, /^https:\/\/(api\.teamorouter\.com|plusvibeapi\.ru)\//u)
    const expected = request.url.startsWith("https://plusvibeapi.ru/") ? "plusvibe" : "teamorouter"
    assert.equal(new Headers(request.init?.headers).get("authorization"), `Bearer key-for-${expected}`)
  }
})

test("accounts: providers without a confirmed account API stay unsupported without requests", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const snapshots = await loadAccountSnapshots(
    fetcher({}, requests),
    new AbortController().signal,
    [{ id: "opencode" }, { id: "apimaster" }],
    async () => "unused",
  )
  assert.deepEqual(
    snapshots.map((snapshot) => [snapshot.providerID, snapshot.state]),
    [["opencode", "unsupported"], ["apimaster", "unsupported"]],
  )
  assert.equal(requests.length, 0)
})

test("accounts: a missing credential is stale without inventing prices or balances", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const snapshots = await loadAccountSnapshots(
    fetcher({}, requests),
    new AbortController().signal,
    [{ id: "teamorouter" }],
    async () => undefined,
  )
  assert.equal(snapshots[0].state, "stale")
  assert.equal(snapshots[0].costs.size, 0)
  assert.equal(snapshots[0].balance, undefined)
  assert.equal(requests.length, 0)
})

test("accounts: refresh failures fall back to the previous snapshot marked stale", async () => {
  const previous = new Map<string, AccountSnapshot>([
    ["plusvibe", {
      providerID: "plusvibe",
      state: "live",
      updatedAt: 7,
      costs: parsePlusVibeModels(plusVibePayload),
      balance: { amount: 100, currency: "RUB" },
      pricingSupported: true,
      balanceSupported: true,
    }],
  ])
  const snapshots = await loadAccountSnapshots(
    fetcher({}, []),
    new AbortController().signal,
    [{ id: "plusvibe" }],
    async () => "key",
    previous,
  )
  assert.equal(snapshots[0].state, "stale")
  assert.equal(snapshots[0].updatedAt, 7)
  assert.deepEqual(snapshots[0].balance, { amount: 100, currency: "RUB" })
  assert.equal(snapshots[0].costs.get("claude-opus")?.cost[0].input, 123)
})

test("accounts: aborting the refresh rejects instead of caching partial data", async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    loadAccountSnapshots(
      fetcher({}, []),
      controller.signal,
      [{ id: "teamorouter" }],
      async () => "key",
    ),
  )
})
