export interface ModelCost {
  tier?: { type: "context"; size: number }
  input: number
  output: number
  cache?: { read: number; write: number }
}

export interface AccountModelCost {
  currency: string
  cost: ModelCost[]
}

export interface AccountBalance {
  amount: number
  currency: string
}

export type AccountState = "live" | "stale" | "unsupported"

/** Where the account credential came from: OpenCode connections or the plugin-owned vault. */
export type AccountKeySource = "plugin" | "opencode"

export interface AccountKey {
  value: string
  source: AccountKeySource
}

export interface AccountSnapshot {
  providerID: string
  state: AccountState
  updatedAt?: number
  costs: ReadonlyMap<string, AccountModelCost>
  balance?: AccountBalance
  pricingSupported: boolean
  balanceSupported: boolean
  keySource?: AccountKeySource
}

export interface AccountProvider {
  id: string
  integrationID?: string
}

interface PricedModel {
  providerID: string
  id: string
  cost?: ModelCost[]
  costCurrency?: string
  priceState?: "live" | "stale"
}

const OPENROUTER_API = "https://openrouter.ai/api/v1"
const TEAMOROUTER_API = "https://api.teamorouter.com/v1"
const PLUSVIBE_API = "https://plusvibeapi.ru"

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined
}

function nonNegative(value: unknown): number | undefined {
  const parsed = number(value)
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

function currency(value: unknown, fallback?: string): string | undefined {
  const candidate = typeof value === "string" && /^[A-Za-z]{3}$/u.test(value)
    ? value.toUpperCase()
    : fallback
  return candidate
}

function cloneCost(cost: ModelCost[]): ModelCost[] {
  return cost.map((tier) => ({
    ...tier,
    tier: tier.tier ? { ...tier.tier } : undefined,
    cache: tier.cache ? { ...tier.cache } : undefined,
  }))
}

function emptySnapshot(
  providerID: string,
  state: AccountState,
  pricingSupported: boolean,
  balanceSupported: boolean,
): AccountSnapshot {
  return { providerID, state, costs: new Map(), pricingSupported, balanceSupported }
}

/** Account prices replace native/public values; unmatched models deliberately have no price. */
export function withAccountPricing<T extends PricedModel>(
  models: readonly T[],
  snapshots: ReadonlyMap<string, AccountSnapshot>,
): T[] {
  return models.map((model) => {
    const { cost: _cost, costCurrency: _currency, priceState: _state, ...base } = model
    const snapshot = snapshots.get(model.providerID)
    const account = snapshot?.costs.get(model.id)
    if (!snapshot || !account || snapshot.state === "unsupported") return base as T
    return {
      ...base,
      cost: cloneCost(account.cost),
      costCurrency: account.currency,
      priceState: snapshot.state,
    } as T
  })
}

/** OpenRouter prices are decimal strings per token; the router uses units per million tokens. */
export function parseOpenRouterModels(payload: unknown): ReadonlyMap<string, AccountModelCost> {
  const costs = new Map<string, AccountModelCost>()
  const models = record(payload)?.data
  if (!Array.isArray(models)) return costs
  for (const value of models) {
    const model = record(value)
    const pricing = record(model?.pricing)
    if (typeof model?.id !== "string" || !model.id || !pricing) continue
    const input = nonNegative(pricing.prompt)
    const output = nonNegative(pricing.completion)
    if (input === undefined || output === undefined) continue
    costs.set(model.id, {
      currency: "USD",
      cost: [{
        input: input * 1_000_000,
        output: output * 1_000_000,
        cache: {
          read: (nonNegative(pricing.input_cache_read) ?? 0) * 1_000_000,
          write: (nonNegative(pricing.input_cache_write) ?? 0) * 1_000_000,
        },
      }],
    })
  }
  return costs
}

export function parseOpenRouterKeyBalance(payload: unknown): AccountBalance | undefined {
  const data = record(record(payload)?.data)
  const amount = number(data?.limit_remaining)
  return amount === undefined ? undefined : { amount, currency: "USD" }
}

export function parseOpenRouterCreditsBalance(payload: unknown): AccountBalance | undefined {
  const data = record(record(payload)?.data)
  const purchased = number(data?.total_credits)
  const used = number(data?.total_usage)
  return purchased === undefined || used === undefined
    ? undefined
    : { amount: purchased - used, currency: "USD" }
}

/** TeamoRouter account model configuration already uses USD per million tokens. */
export function parseTeamoRouterModels(payload: unknown): ReadonlyMap<string, AccountModelCost> {
  const costs = new Map<string, AccountModelCost>()
  const providers = record(record(record(payload)?.models)?.providers)
  for (const provider of Object.values(providers ?? {})) {
    const models = record(provider)?.models
    if (!Array.isArray(models)) continue
    for (const value of models) {
      const model = record(value)
      const source = record(model?.cost)
      if (typeof model?.id !== "string" || !model.id || !source) continue
      const input = nonNegative(source.input)
      const output = nonNegative(source.output)
      if (input === undefined || output === undefined) continue
      costs.set(model.id, {
        currency: "USD",
        cost: [{
          input,
          output,
          cache: {
            read: nonNegative(source.cacheRead) ?? 0,
            write: nonNegative(source.cacheWrite) ?? 0,
          },
        }],
      })
    }
  }
  return costs
}

export function parseTeamoRouterBalance(payload: unknown): AccountBalance | undefined {
  const data = record(record(payload)?.data)
  const amount = number(data?.availableBalance ?? data?.available_balance ?? data?.totalBalance ?? data?.total_balance)
  const unit = currency(data?.currency, "USD")
  return amount === undefined || !unit ? undefined : { amount, currency: unit }
}

/** PlusVibe account pricing is RUB per million tokens; only the declared default variant is mapped. */
export function parsePlusVibeModels(payload: unknown): ReadonlyMap<string, AccountModelCost> {
  const costs = new Map<string, AccountModelCost>()
  const root = record(payload)
  const entries = root?.data
  if (!Array.isArray(entries)) return costs
  const unit = currency(root?.currency, "RUB")
  if (!unit) return costs
  for (const value of entries) {
    const entry = record(value)
    if (typeof entry?.model !== "string" || !entry.model) continue
    const variants = entry.variants
    if (!Array.isArray(variants)) continue
    // Non-default variants are provider alias routes; their OpenCode IDs are not guessed.
    const source = variants.map(record).find((variant) => variant?.isDefault === true)
    if (!source) continue
    const input = nonNegative(source.inputRub)
    const output = nonNegative(source.outputRub)
    if (input === undefined || output === undefined) continue
    costs.set(entry.model, {
      currency: unit,
      cost: [{
        input,
        output,
        cache: {
          read: nonNegative(source.cacheReadRub) ?? 0,
          write: nonNegative(source.cacheWriteRub) ?? 0,
        },
      }],
    })
  }
  return costs
}

export function parsePlusVibeBalance(payload: unknown): AccountBalance | undefined {
  const data = record(payload)
  const amount = number(data?.balance ?? data?.balanceRub ?? data?.balance_rub)
  const unit = currency(data?.currency, "RUB")
  return amount === undefined || !unit ? undefined : { amount, currency: unit }
}

async function requestJSON(
  fetcher: typeof fetch,
  url: string,
  key: string,
  signal: AbortSignal,
  bothAuthHeaders = false,
): Promise<unknown> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  timeout.unref?.()
  if (signal.aborted) abort()
  else signal.addEventListener("abort", abort, { once: true })
  try {
    const response = await fetcher(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${key}`,
        ...(bothAuthHeaders ? { "x-api-key": key } : {}),
      },
      cache: "no-cache",
      redirect: "error",
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`account API returned HTTP ${response.status}`)
    const length = Number(response.headers.get("content-length"))
    if (Number.isFinite(length) && length > 32 * 1024 * 1024) {
      throw new Error("account API response is too large")
    }
    return await response.json() as unknown
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener("abort", abort)
  }
}

async function openRouter(
  fetcher: typeof fetch,
  key: string,
  signal: AbortSignal,
): Promise<AccountSnapshot> {
  const [models, keyInfo] = await Promise.all([
    requestJSON(fetcher, `${OPENROUTER_API}/models/user`, key, signal),
    requestJSON(fetcher, `${OPENROUTER_API}/key`, key, signal),
  ])
  let balance = parseOpenRouterKeyBalance(keyInfo)
  if (!balance) {
    try {
      balance = parseOpenRouterCreditsBalance(
        await requestJSON(fetcher, `${OPENROUTER_API}/credits`, key, signal),
      )
    } catch (error) {
      if (signal.aborted) throw error
      // Some key types cannot read credits. Missing balance stays unknown.
    }
  }
  return {
    ...emptySnapshot("openrouter", "live", true, true),
    updatedAt: Date.now(),
    costs: parseOpenRouterModels(models),
    balance,
  }
}

async function teamoRouter(
  fetcher: typeof fetch,
  key: string,
  signal: AbortSignal,
): Promise<AccountSnapshot> {
  const [models, balanceInfo] = await Promise.all([
    requestJSON(fetcher, `${TEAMOROUTER_API}/models/config`, key, signal),
    requestJSON(fetcher, `${TEAMOROUTER_API}/billing/me/balance`, key, signal),
  ])
  const balance = parseTeamoRouterBalance(balanceInfo)
  if (!balance) throw new Error("account API returned no recognized balance")
  return {
    ...emptySnapshot("teamorouter", "live", true, true),
    updatedAt: Date.now(),
    costs: parseTeamoRouterModels(models),
    balance,
  }
}

async function plusVibe(
  fetcher: typeof fetch,
  key: string,
  signal: AbortSignal,
): Promise<AccountSnapshot> {
  const [pricing, balanceInfo] = await Promise.all([
    requestJSON(fetcher, `${PLUSVIBE_API}/v1/pricing`, key, signal, true),
    requestJSON(fetcher, `${PLUSVIBE_API}/v1/balance`, key, signal, true),
  ])
  const balance = parsePlusVibeBalance(balanceInfo)
  if (!balance) throw new Error("account API returned no recognized balance")
  return {
    ...emptySnapshot("plusvibe", "live", true, true),
    updatedAt: Date.now(),
    costs: parsePlusVibeModels(pricing),
    balance,
  }
}

export interface CbrRates {
  /** Rate date exactly as published by the ЦБ РФ feed (DD.MM.YYYY). */
  date: string
  /** Rubles per one unit of each currency; RUB itself is always 1. */
  rates: Record<string, number>
  fetchedAt: number
}

/** Official ЦБ РФ daily feed; the windows-1251 body carries the rate date as published. */
const CBR_API = "https://www.cbr.ru/scripts/XML_daily.asp"

function tagText(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "iu"))
  return match?.[1].trim()
}

function cbrNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  // The feed uses a comma decimal separator and may contain non-breaking spaces.
  const parsed = Number(value.replace(/[\s\u00a0]/gu, "").replace(",", "."))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * ЦБ РФ daily XML → RUB-based rates, parsed without dependencies. Only ASCII
 * char codes and digits are used, so the windows-1251 encoding of the feed
 * cannot corrupt them. Unrecognized entries are skipped, never invented.
 */
export function parseCbrDaily(xml: string): Omit<CbrRates, "fetchedAt"> | undefined {
  if (typeof xml !== "string") return undefined
  const date = xml.match(/<ValCurs[^>]*\bDate="(\d{2}\.\d{2}\.\d{4})"/iu)?.[1]
  if (!date) return undefined
  const rates: Record<string, number> = { RUB: 1 }
  for (const block of xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/giu)) {
    const body = block[1]
    const code = tagText(body, "CharCode")
    if (!code || !/^[A-Za-z]{3}$/u.test(code)) continue
    // VunitRate is already per one unit; Value covers Nominal units.
    const unitRate = cbrNumber(tagText(body, "VunitRate"))
    const nominal = cbrNumber(tagText(body, "Nominal")) ?? 1
    const value = cbrNumber(tagText(body, "Value"))
    const rate = unitRate ?? (value !== undefined ? value / nominal : undefined)
    if (rate === undefined) continue
    rates[code.toUpperCase()] = rate
  }
  // A feed without any recognized currency is not a rate source.
  return Object.keys(rates).length > 1 ? { date, rates } : undefined
}

/**
 * Display-only orientation source: the hardcoded public ЦБ РФ origin is called
 * without credentials and with the same guardrails as the account APIs.
 */
export async function loadCbrRates(fetcher: typeof fetch, signal: AbortSignal): Promise<CbrRates> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  timeout.unref?.()
  if (signal.aborted) abort()
  else signal.addEventListener("abort", abort, { once: true })
  try {
    const response = await fetcher(CBR_API, {
      headers: { accept: "text/xml, application/xml, text/plain" },
      cache: "no-cache",
      redirect: "error",
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`exchange-rate API returned HTTP ${response.status}`)
    const length = Number(response.headers.get("content-length"))
    if (Number.isFinite(length) && length > 4 * 1024 * 1024) {
      throw new Error("exchange-rate response is too large")
    }
    const parsed = parseCbrDaily(await response.text())
    if (!parsed) throw new Error("exchange-rate feed is not recognized")
    return { ...parsed, fetchedAt: Date.now() }
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener("abort", abort)
  }
}

function capabilities(providerID: string): { pricing: boolean; balance: boolean; supported: boolean } {
  switch (providerID) {
    case "openrouter":
    case "teamorouter":
    case "plusvibe":
      return { pricing: true, balance: true, supported: true }
    default:
      return { pricing: false, balance: false, supported: false }
  }
}

export async function loadAccountSnapshots(
  fetcher: typeof fetch,
  signal: AbortSignal,
  providers: readonly AccountProvider[],
  resolveKey: (provider: AccountProvider) => Promise<AccountKey | undefined>,
  previous: ReadonlyMap<string, AccountSnapshot> = new Map(),
): Promise<AccountSnapshot[]> {
  const unique = [...new Map(providers.map((provider) => [provider.id, provider])).values()]
  const snapshots = await Promise.all(unique.map(async (provider): Promise<AccountSnapshot | undefined> => {
    const capability = capabilities(provider.id)
    let key: AccountKey | undefined
    try {
      key = await resolveKey(provider)
      if (!capability.supported) {
        // Providers without a confirmed account API only surface when actually connected.
        return key ? { ...emptySnapshot(provider.id, "unsupported", false, false), keySource: key.source } : undefined
      }
      if (!key) throw new Error("account credentials are unavailable")
      if (signal.aborted) throw new Error("account refresh was aborted")
      const snapshot = await (() => {
        switch (provider.id) {
          case "openrouter":
            return openRouter(fetcher, key!.value, signal)
          case "teamorouter":
            return teamoRouter(fetcher, key!.value, signal)
          case "plusvibe":
            return plusVibe(fetcher, key!.value, signal)
          default:
            return Promise.resolve(emptySnapshot(provider.id, "unsupported", false, false))
        }
      })()
      return { ...snapshot, keySource: key.source }
    } catch (error) {
      if (signal.aborted) throw error
      const cached = previous.get(provider.id)
      // A cached snapshot only keeps its key source while the credential still resolves;
      // a cleared vault key or removed connection must not claim a source it no longer has.
      return cached
        ? { ...cached, state: "stale", keySource: key?.source }
        : emptySnapshot(provider.id, "stale", capability.pricing, capability.balance)
    }
  }))
  return snapshots.filter((snapshot): snapshot is AccountSnapshot => snapshot !== undefined)
}
