export type Strategy = "free-fastest" | "fastest" | "cheapest" | "manual"
export type Grouping = "provider" | "model" | "route" | "price" | "speed"
export type Sorting = "name" | "provider" | "price" | "speed" | "ttfb"
/** Account tariffs (`live`/`stale`) always take priority over public listings. */
export type PriceState = "live" | "stale" | "public" | "public-stale"

export interface CatalogModel {
  model: string
  providerID: string
  id: string
  name?: string
  enabled: boolean
  routingEnabled: boolean
  costCurrency?: string
  priceState?: PriceState
  free: boolean
  available: boolean
  cooldownMs: number
  successes: number
  failures: number
  latencyMs?: number
  ttfbMs?: number
  outputTokensPerSecond?: number
  totalCostUSD: number
  generatedTokens: number
  actualCostPerMillionUSD?: number
  variants: string[]
  groups: string[]
  cost?: Array<{
    tier?: { type: string; size: number }
    input: number
    output: number
    cache?: { read?: number; write?: number }
  }>
  limit?: { context?: number; output?: number }
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] }
  priceLimitBreached?: boolean
  thresholdExcluded?: boolean
}

export interface ManualGroup {
  name: string
  strategy: Strategy
  models: string[]
}

export interface AccountThreshold {
  minBalance?: number
  action?: "warn" | "exclude"
}

/**
 * Global price bounds keyed by the account price currency (e.g. "USD", "RUB").
 * They apply to every model with a confirmed account price in that currency
 * across all providers; values in different currencies never mix.
 */
export interface PriceLimits {
  inputMin?: number
  inputMax?: number
  outputMin?: number
  outputMax?: number
  action?: "warn" | "exclude"
}

export interface CbrInfo {
  /** Rate date exactly as published by the ЦБ РФ feed (DD.MM.YYYY). */
  date: string
  fetchedAt: string
  stale: boolean
  /** Rubles per one unit; RUB itself is always 1. */
  rates: Record<string, number>
}

/** Result of unauthenticated public price discovery for one provider site. */
export interface PublicPricingInfo {
  providerID: string
  /** Exact endpoint URL that returned recognized prices. */
  origin: string
  state: "live" | "stale"
  fetchedAt: string
  stale: boolean
  matchedModels: number
}

/**
 * Providers whose account key can be stored in the plugin vault. Mirrors
 * `VAULT_PROVIDERS` in vault.ts and the RPC enum in rpc.ts (kept in sync by
 * test/vault.test.ts); vault.ts cannot be imported here because node:crypto
 * must never reach the GUI bundle.
 */
export const VAULT_PROVIDER_IDS: readonly string[] = ["openrouter", "teamorouter", "plusvibe"]

export interface AccountInfo {
  providerID: string
  state: "live" | "stale" | "unsupported"
  updatedAt?: string
  pricingSupported: boolean
  balanceSupported: boolean
  matchedModels: number
  balance?: number
  balanceCurrency?: string
  lowBalance?: boolean
  keySource?: "plugin" | "opencode"
  pluginKey?: boolean
}

export interface RouterStatus {
  enabled: boolean
  autoDiscover: boolean
  strategy: Strategy
  defaultGroup?: string
  resumeAfterFailover: boolean
  cooldownMs: number
  metricAlpha: number
  rescanIntervalMs: number
  accountThresholds: Record<string, AccountThreshold>
  priceLimits: Record<string, PriceLimits>
  cbrOrientation: boolean
  cbr?: CbrInfo
  providerSites: Record<string, string>
  publicPricing: PublicPricingInfo[]
  accounts: AccountInfo[]
  disabledModels: string[]
  manualGroups: ManualGroup[]
  modelsDiscovered: number
  models: CatalogModel[]
  groups: Array<{
    name: string
    automatic: boolean
    strategy: Strategy
    candidates: Array<{ model: string }>
  }>
}

export interface CatalogSection {
  key: string
  title: string
  models: CatalogModel[]
}

export function catalogPrice(model: CatalogModel): number {
  const tier = model.cost?.[0]
  return tier ? tier.input + tier.output : Number.POSITIVE_INFINITY
}

/** Prices always carry their account currency; unknown prices have no currency and never compare. */
export function priceCurrency(model: CatalogModel): string | undefined {
  return model.cost?.length ? model.costCurrency ?? "USD" : undefined
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", RUB: "₽", EUR: "€" }

export function currencySymbol(currency: string | undefined): string {
  return currency ? CURRENCY_SYMBOLS[currency] ?? `${currency} ` : ""
}

export function formatPrice(value: number | undefined, currency?: string): string {
  if (value === undefined || !Number.isFinite(value)) return "—"
  const formatted = value.toLocaleString("ru-RU", { maximumFractionDigits: 3 })
  if (!currency) return formatted
  const symbol = CURRENCY_SYMBOLS[currency]
  return symbol ? `${symbol}${formatted}` : `${formatted} ${currency}`
}

export function formatBalance(amount: number | undefined, currency: string | undefined): string {
  if (amount === undefined || !Number.isFinite(amount)) return "—"
  const formatted = amount.toLocaleString("ru-RU", { maximumFractionDigits: 2 })
  const symbol = currency ? CURRENCY_SYMBOLS[currency] : undefined
  return symbol ? `${formatted} ${symbol}` : `${formatted}${currency ? ` ${currency}` : ""}`
}

/**
 * Cross-rate between two currencies via the RUB base of the ЦБ РФ feed.
 * Display-only orientation: a missing rate yields undefined and the value is
 * never shown, and routing code never converts currencies.
 */
export function cbrCross(
  rates: Record<string, number> | undefined,
  from: string | undefined,
  to: string | undefined,
): number | undefined {
  if (!from || !to) return undefined
  if (from === to) return 1
  const base = rates?.[from]
  const quote = rates?.[to]
  if (!base || !quote || !Number.isFinite(base) || !Number.isFinite(quote)) return undefined
  return base / quote
}

export function cbrConvert(
  rates: Record<string, number> | undefined,
  amount: number | undefined,
  from: string | undefined,
  to: string | undefined,
): number | undefined {
  if (amount === undefined || !Number.isFinite(amount)) return undefined
  const rate = cbrCross(rates, from, to)
  return rate === undefined ? undefined : amount * rate
}

/** All currencies in which account balances and confirmed prices are presented. */
export function accountCurrencies(status: Pick<RouterStatus, "accounts" | "models">): string[] {
  const currencies = new Set<string>()
  for (const account of status.accounts) {
    if (account.balance !== undefined && account.balanceCurrency) currencies.add(account.balanceCurrency)
  }
  for (const model of status.models) {
    const unit = priceCurrency(model)
    if (unit && Number.isFinite(catalogPrice(model))) currencies.add(unit)
  }
  return [...currencies].sort()
}

export function formatSpeed(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ток/с`
}

export function formatLatency(value: number | undefined): string {
  if (value === undefined) return "—"
  return value >= 1000
    ? `${(value / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`
    : `${Math.round(value)} мс`
}

function priceBucket(model: CatalogModel): string {
  const unit = priceCurrency(model)
  const price = catalogPrice(model)
  if (!unit || !Number.isFinite(price)) return "Цена неизвестна"
  if (price === 0) return "Бесплатные"
  // Buckets never mix currencies: no exchange rate is assumed anywhere in the GUI.
  return unit === "USD"
    ? price <= 2
      ? "До $2 за 1M input + output"
      : price <= 10
        ? "$2–10 за 1M input + output"
        : "Дороже $10 за 1M input + output"
    : `Цены в ${unit} за 1M input + output`
}

function speedBucket(model: CatalogModel): string {
  const speed = model.outputTokensPerSecond
  if (speed === undefined) return "Скорость ещё не измерена"
  if (speed >= 100) return "Быстрые · от 100 ток/с"
  if (speed >= 20) return "Средние · 20–100 ток/с"
  return "Медленные · до 20 ток/с"
}

function groupTitle(model: CatalogModel, grouping: Grouping): string {
  switch (grouping) {
    case "provider":
      return model.providerID
    case "model":
      return model.id
    case "route":
      return model.groups[0] ?? "Вне route-групп"
    case "price":
      return priceBucket(model)
    case "speed":
      return speedBucket(model)
  }
}

export function organizeModels(
  models: CatalogModel[],
  options: {
    search?: string
    grouping?: Grouping
    sorting?: Sorting
    enabledOnly?: boolean
  } = {},
): CatalogSection[] {
  const query = options.search?.trim().toLocaleLowerCase() ?? ""
  const grouping = options.grouping ?? "provider"
  const sorting = options.sorting ?? "name"
  const filtered = models.filter((model) => {
    if (options.enabledOnly && !model.routingEnabled) return false
    if (!query) return true
    return [model.model, model.name, model.providerID, model.id, ...model.groups]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(query))
  })
  const sorted = [...filtered].sort((left, right) => {
    let difference = 0
    switch (sorting) {
      case "name":
        difference = (left.name ?? left.id).localeCompare(right.name ?? right.id)
        break
      case "provider":
        difference = left.providerID.localeCompare(right.providerID)
        break
      case "price": {
        const leftCurrency = priceCurrency(left)
        const rightCurrency = priceCurrency(right)
        // Mixed currencies are ordered by currency, never converted or compared numerically.
        if (leftCurrency === rightCurrency) difference = catalogPrice(left) - catalogPrice(right)
        else if (leftCurrency === undefined) difference = 1
        else if (rightCurrency === undefined) difference = -1
        else difference = leftCurrency.localeCompare(rightCurrency)
        break
      }
      case "speed":
        difference =
          (right.outputTokensPerSecond ?? Number.NEGATIVE_INFINITY) -
          (left.outputTokensPerSecond ?? Number.NEGATIVE_INFINITY)
        break
      case "ttfb":
        difference =
          (left.ttfbMs ?? Number.POSITIVE_INFINITY) - (right.ttfbMs ?? Number.POSITIVE_INFINITY)
        break
    }
    return difference || left.model.localeCompare(right.model)
  })

  const buckets = new Map<string, CatalogModel[]>()
  for (const model of sorted) {
    const title = groupTitle(model, grouping)
    const bucket = buckets.get(title) ?? []
    bucket.push(model)
    buckets.set(title, bucket)
  }
  return [...buckets.entries()]
    .map(([title, sectionModels]) => ({ key: `${grouping}:${title}`, title, models: sectionModels }))
    .sort((left, right) => left.title.localeCompare(right.title))
}
