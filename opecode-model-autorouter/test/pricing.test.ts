import assert from "node:assert/strict"
import test from "node:test"
import {
  extractProviderSite,
  loadAccountSnapshots,
  loadCbrRates,
  loadPublicPricing,
  normalizeSiteURL,
  parseCbrDaily,
  parseOpenRouterCreditsBalance,
  parseOpenRouterKeyBalance,
  parseOpenRouterModels,
  parsePlusVibeBalance,
  parsePlusVibeModels,
  parsePublicModels,
  parseTeamoRouterBalance,
  parseTeamoRouterModels,
  publicEndpointCandidates,
  withAccountPricing,
  withPublicPricing,
  type AccountSnapshot,
  type PriceState,
  type PublicSnapshot,
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
    async (provider) => ({ value: `key-for-${provider.id}`, source: "opencode" }),
  )
  const byProvider = new Map(snapshots.map((snapshot) => [snapshot.providerID, snapshot]))
  assert.equal(byProvider.get("teamorouter")?.state, "live")
  assert.equal(byProvider.get("teamorouter")?.keySource, "opencode")
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
    async () => ({ value: "unused", source: "opencode" }),
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
    async () => ({ value: "key", source: "plugin" }),
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
      async () => ({ value: "key", source: "opencode" }),
    ),
  )
})

const cbrXml = `<?xml version="1.0" encoding="windows-1251"?>
<ValCurs Date="31.10.2026" name="Ежедневные курсы валют">
  <Valute ID="R01235">
    <NumCode>840</NumCode>
    <CharCode>USD</CharCode>
    <Nominal>1</Nominal>
    <Name>Доллар США</Name>
    <Value>92,5123</Value>
    <VunitRate>92,5123</VunitRate>
  </Valute>
  <Valute ID="R01398">
    <NumCode>398</NumCode>
    <CharCode>KZT</CharCode>
    <Nominal>100</Nominal>
    <Name>Казахстанских тенге</Name>
    <Value>17,3456</Value>
    <VunitRate>0,1735</VunitRate>
  </Valute>
  <Valute ID="R01239">
    <CharCode>EUR</CharCode>
    <Nominal>1</Nominal>
    <Name>Евро</Name>
    <Value>107,1234</Value>
  </Valute>
  <Valute ID="R00000">
    <CharCode>XXX</CharCode>
    <Nominal>1</Nominal>
    <Name>Битая запись</Name>
    <Value>не число</Value>
  </Valute>
</ValCurs>`

test("cbr: daily XML becomes RUB-based rates with the published date", () => {
  const parsed = parseCbrDaily(cbrXml)
  assert.equal(parsed?.date, "31.10.2026")
  assert.equal(parsed?.rates.USD, 92.5123)
  // VunitRate is already per one unit and wins over Value/Nominal.
  assert.equal(parsed?.rates.KZT, 0.1735)
  assert.equal(parsed?.rates.EUR, 107.1234)
  // The base is defined by the parser, never fetched or invented.
  assert.equal(parsed?.rates.RUB, 1)
  assert.equal(parsed && "XXX" in parsed.rates, false)
  assert.equal(parseCbrDaily("<html>not a feed</html>"), undefined)
  assert.equal(parseCbrDaily('<ValCurs Date="31.10.2026"></ValCurs>'), undefined)
})

function xmlFetcher(body: string, requests: Array<{ url: string; init?: RequestInit }>, status = 200) {
  return (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    // The real fetch rejects on an aborted signal; mirror that boundary here.
    if (init?.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError")
    return new Response(body, {
      status,
      headers: { "content-type": "text/xml; charset=windows-1251" },
    })
  }) as typeof fetch
}

test("cbr: the loader uses only the hardcoded origin without credentials and rejects bad feeds", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const rates = await loadCbrRates(xmlFetcher(cbrXml, requests), new AbortController().signal)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, "https://www.cbr.ru/scripts/XML_daily.asp")
  // The public feed is anonymous: no credential headers are attached.
  assert.equal(new Headers(requests[0].init?.headers).get("authorization"), null)
  assert.equal(rates.date, "31.10.2026")
  assert.equal(rates.rates.USD, 92.5123)
  assert.ok(rates.fetchedAt > 0)
  await assert.rejects(loadCbrRates(xmlFetcher(cbrXml, [], 500), new AbortController().signal))
  await assert.rejects(loadCbrRates(xmlFetcher("not a feed", []), new AbortController().signal))
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(loadCbrRates(xmlFetcher(cbrXml, []), aborted.signal))
})

test("public pricing: site validation accepts https and loopback only, strips credentials", () => {
  assert.equal(normalizeSiteURL("https://openrouter.ai"), "https://openrouter.ai")
  assert.equal(normalizeSiteURL("https://openrouter.ai/"), "https://openrouter.ai")
  assert.equal(normalizeSiteURL("https://openrouter.ai/?ref=x#top"), "https://openrouter.ai")
  assert.equal(normalizeSiteURL("https://api.example.com/v1"), "https://api.example.com/v1")
  assert.equal(normalizeSiteURL("http://localhost:8080"), "http://localhost:8080")
  assert.equal(normalizeSiteURL("http://127.0.0.1/x"), "http://127.0.0.1/x")
  // Non-loopback http and non-HTTP schemes are never called.
  assert.equal(normalizeSiteURL("http://example.com"), undefined)
  assert.equal(normalizeSiteURL("javascript:alert(1)"), undefined)
  assert.equal(normalizeSiteURL("data:text/html,<script>"), undefined)
  assert.equal(normalizeSiteURL("file:///C:/secrets"), undefined)
  // Embedded credentials are rejected instead of being sent anywhere.
  assert.equal(normalizeSiteURL("https://user:pass@example.com"), undefined)
  // Garbage values never become addresses.
  assert.equal(normalizeSiteURL(""), undefined)
  assert.equal(normalizeSiteURL("not a url"), undefined)
  assert.equal(normalizeSiteURL(42), undefined)
  assert.equal(normalizeSiteURL(null), undefined)
  assert.equal(normalizeSiteURL({ url: "https://example.com" }), undefined)
  assert.equal(normalizeSiteURL(`https://x.example/${"y".repeat(4096)}`), undefined)
})

test("public pricing: config baseURL is extracted best-effort and validated", () => {
  assert.equal(
    extractProviderSite({ id: "p", settings: { options: { baseURL: "https://api.p.example/v1" } } }),
    "https://api.p.example/v1",
  )
  assert.equal(
    extractProviderSite({ id: "p", settings: { baseURL: "https://p.example" } }),
    "https://p.example",
  )
  assert.equal(extractProviderSite({ id: "p", baseURL: "https://p.example" }), "https://p.example")
  assert.equal(extractProviderSite({ id: "p", settings: { options: { baseURL: "http://evil.example" } } }), undefined)
  assert.equal(extractProviderSite({ id: "p" }), undefined)
  assert.equal(extractProviderSite(null), undefined)
  assert.equal(extractProviderSite("https://p.example"), undefined)
})

test("public pricing: endpoint candidates are ordered, capped and derived from the address", () => {
  assert.deepEqual(publicEndpointCandidates("https://p.example"), [
    "https://p.example/v1/models",
    "https://p.example/api/v1/models",
    "https://p.example/models",
    "https://p.example/api/models",
  ])
  // An address that already points at a listing is probed first.
  assert.deepEqual(publicEndpointCandidates("https://p.example/v1/models")[0], "https://p.example/v1/models")
  assert.equal(publicEndpointCandidates("https://p.example/v1/models").length, 5)
  assert.deepEqual(publicEndpointCandidates("javascript:alert(1)"), [])
  assert.deepEqual(publicEndpointCandidates(""), [])
})

test("public pricing: only the OpenRouter-compatible shape is recognized, nothing is invented", () => {
  const costs = parsePublicModels({
    data: [{ id: "m", pricing: { prompt: "0.000001", completion: "0.000002" } }],
  })
  assert.deepEqual(costs.get("m"), {
    currency: "USD",
    cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }],
  })
  // A bare top-level array is accepted too.
  assert.equal(
    parsePublicModels([{ id: "m", pricing: { prompt: 1e-6, completion: 2e-6 } }]).size,
    1,
  )
  // A plain OpenAI listing without prices yields nothing: no price is guessed.
  assert.equal(parsePublicModels({ data: [{ id: "m", object: "model", owned_by: "x" }] }).size, 0)
  // Unknown units/currencies are not interpreted.
  assert.equal(parsePublicModels({ data: [{ id: "m", cost: { input: 5, output: 9, currency: "RUB" } }] }).size, 0)
  for (const garbage of [null, undefined, 0, "", "text", [], {}, { data: "x" }, { data: [null, 1, "s"] }]) {
    assert.equal(parsePublicModels(garbage).size, 0)
  }
})

function jsonFetcher(
  routes: Record<string, { status?: number; body?: unknown; raw?: string; length?: number }>,
  requests: Array<{ url: string; init?: RequestInit }>,
) {
  return (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    if (init?.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError")
    const route = routes[String(url)]
    if (!route) return new Response("not found", { status: 404 })
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (route.length !== undefined) headers["content-length"] = String(route.length)
    return new Response(route.raw ?? JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers,
    })
  }) as typeof fetch
}

const publicListing = {
  data: [{ id: "same", pricing: { prompt: "0.000001", completion: "0.000002" } }],
}

test("public pricing: the loader probes in order, stays anonymous and fails cleanly", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const snapshot = await loadPublicPricing(
    jsonFetcher(
      {
        "https://p.example/v1/models": { status: 500 },
        "https://p.example/api/v1/models": { body: "<html>not json</html>", raw: "<html>" },
        "https://p.example/models": { body: publicListing },
      },
      requests,
    ),
    new AbortController().signal,
    "p",
    "https://p.example",
  )
  assert.equal(snapshot.origin, "https://p.example/models")
  assert.equal(snapshot.state, "live")
  assert.equal(snapshot.providerID, "p")
  assert.deepEqual([...snapshot.costs.keys()], ["same"])
  assert.equal(requests.length, 3)
  for (const request of requests) {
    const headers = new Headers(request.init?.headers)
    // Strictly unauthenticated discovery: no credentials in any form.
    assert.equal(headers.get("authorization"), null)
    assert.equal(headers.get("cookie"), null)
    assert.equal(request.init?.credentials, "omit")
    assert.equal(request.init?.redirect, "error")
    assert.equal(request.init?.method, undefined)
  }

  // A listing without recognized prices is not a price source.
  await assert.rejects(
    loadPublicPricing(
      jsonFetcher({}, []),
      new AbortController().signal,
      "p",
      "https://p.example",
    ),
  )
  // Oversized responses are rejected before parsing.
  await assert.rejects(
    loadPublicPricing(
      jsonFetcher({ "https://p.example/v1/models": { body: publicListing, length: 64 * 1024 * 1024 } }, []),
      new AbortController().signal,
      "p",
      "https://p.example",
    ),
  )
  // An invalid address produces no requests at all.
  const invalid: Array<{ url: string }> = []
  await assert.rejects(
    loadPublicPricing(jsonFetcher({}, invalid as never), new AbortController().signal, "p", "http://evil.example"),
  )
  assert.equal(invalid.length, 0)
  // Abort propagates instead of being swallowed.
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(loadPublicPricing(jsonFetcher({}, []), aborted.signal, "p", "https://p.example"))
})

test("public pricing: a hanging endpoint is aborted, not awaited forever", async () => {
  const controller = new AbortController()
  const hanging = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("This operation was aborted", "AbortError")),
      )
    })) as unknown as typeof fetch
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(loadPublicPricing(hanging, controller.signal, "p", "https://p.example"))
})

test("public pricing: account prices win and public prices fill the rest", () => {
  const models: Array<{
    providerID: string
    id: string
    cost?: Array<{ input: number; output: number }>
    costCurrency?: string
    priceState?: PriceState
  }> = [
    { providerID: "p", id: "both" },
    { providerID: "p", id: "only-public" },
    { providerID: "q", id: "none" },
  ]
  const accounts = new Map<string, AccountSnapshot>([
    [
      "p",
      {
        providerID: "p",
        state: "live" as const,
        costs: new Map([["both", { currency: "USD", cost: [{ input: 7, output: 8 }] }]]),
        pricingSupported: true,
        balanceSupported: true,
      },
    ],
  ])
  const publics = new Map<string, PublicSnapshot>([
    [
      "p",
      {
        providerID: "p",
        origin: "https://p.example/models",
        state: "live",
        fetchedAt: Date.now(),
        costs: new Map([
          ["both", { currency: "USD", cost: [{ input: 1, output: 2 }] }],
          ["only-public", { currency: "USD", cost: [{ input: 3, output: 4 }] }],
        ]),
      },
    ],
  ])
  const priced = withPublicPricing(withAccountPricing(models, accounts), publics)
  const [both, onlyPublic, none] = priced
  // The account tariff replaces the public listing for the same model.
  assert.equal(both.priceState, "live")
  assert.equal(both.cost?.[0].input, 7)
  assert.equal(onlyPublic.priceState, "public")
  assert.equal(onlyPublic.costCurrency, "USD")
  assert.equal(onlyPublic.cost?.[0].output, 4)
  assert.equal(none.priceState, undefined)
  assert.equal(none.cost, undefined)

  // A stale public listing is marked as cache, never as fresh.
  const stalePublics = new Map([
    ["p", { ...publics.get("p")!, state: "stale" as const }],
  ])
  const stale = withPublicPricing(withAccountPricing(models, new Map()), stalePublics)
  assert.equal(stale[1].priceState, "public-stale")
})
