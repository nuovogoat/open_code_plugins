import {
  accountCapable,
  extractProviderSite,
  loadAccountSnapshots,
  loadCbrRates,
  loadPublicPricing,
  normalizeSiteURL,
  withAccountPricing,
  withPublicPricing,
  type AccountKey,
  type AccountProvider,
  type AccountSnapshot,
  type CbrRates,
  type ModelCost,
  type PriceState,
  type PublicSnapshot,
} from "./pricing.ts"
import { openAccountVault, type AccountVault } from "./vault.ts"

export type Strategy = "free-fastest" | "fastest" | "cheapest" | "manual"

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface ModelInfo extends ModelRef {
  name?: string
  type?: string
  enabled?: boolean
  capabilities?: {
    tools?: boolean
    input?: string[]
    output?: string[]
  }
  variants?: Array<{ id: string }>
  limit?: {
    context?: number
    output?: number
  }
  cost?: ModelCost[]
  costCurrency?: string
  priceState?: PriceState
}

interface GroupOptions {
  models: Array<string | ModelRef>
  strategy?: Strategy
}

export interface AccountThreshold {
  /** Minimum acceptable account balance, in the account's own currency. */
  minBalance?: number
  /** "warn" only marks values; "exclude" also removes affected models from routing. */
  action?: "warn" | "exclude"
}

export interface PriceLimits {
  /** Lower bound for the first-tier input price per 1M, in the price currency. */
  inputMin?: number
  /** Upper bound for the first-tier input price per 1M, in the price currency. */
  inputMax?: number
  /** Lower bound for the first-tier output price per 1M, in the price currency. */
  outputMin?: number
  /** Upper bound for the first-tier output price per 1M, in the price currency. */
  outputMax?: number
  /** "warn" only marks values; "exclude" also removes affected models from routing. */
  action?: "warn" | "exclude"
}

export interface RouterOptions {
  enabled?: boolean
  autoDiscover?: boolean
  strategy?: Strategy
  defaultGroup?: string
  groups?: Record<string, GroupOptions>
  disabledModels?: string[]
  cooldownMs?: number
  resumeAfterFailover?: boolean
  /**
   * When a prompt arrives for a session whose current model was NOT set by the
   * router (explicit user/config choice), the router asks before overriding:
   * it registers an override request (GUI + one synthetic notice) instead of
   * switching silently. Default true; set false for fully automatic routing.
   */
  askBeforeOverride?: boolean
  metricAlpha?: number
  rescanIntervalMs?: number
  accountThresholds?: Record<string, AccountThreshold>
  /** Price bounds keyed by price currency; applied to every confirmed account price. */
  priceLimits?: Record<string, PriceLimits>
  /**
   * Provider homepage/API addresses for unauthenticated public price discovery.
   * Requests to these addresses never carry credentials; account keys are only
   * ever sent to the fixed account-API origins in pricing.ts.
   */
  providerSites?: Record<string, string>
  cbrOrientation?: boolean
}

export interface Candidate extends ModelRef {
  info: ModelInfo
  order: number
  /** Keep disabled models for current-model lookup, but never select them. */
  disabled?: boolean
}

export interface RouteGroup {
  name: string
  strategy: Strategy
  automatic: boolean
  candidates: Candidate[]
}

export interface ModelMetrics {
  successes: number
  failures: number
  latencyMs?: number
  ttfbMs?: number
  outputTokensPerSecond?: number
  totalCostUSD: number
  generatedTokens: number
}

export interface StepTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

/** Token counters of a finished step; unrecognized or negative values become zero — nothing is invented. */
export function parseStepTokens(data: any): StepTokens {
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
  const raw = data?.tokens
  return {
    input: num(raw?.input),
    output: num(raw?.output),
    reasoning: num(raw?.reasoning),
    cacheRead: num(raw?.cache?.read),
    cacheWrite: num(raw?.cache?.write),
  }
}

/**
 * Step cost at a confirmed account tariff (per million tokens, first tier).
 * Reasoning tokens are billed at the output rate — they are generated tokens.
 * Cache tokens are billed only when the tariff declares cache rates; undeclared
 * rates are never guessed. Without a tariff the cost is undefined, and the
 * caller falls back to the cost OpenCode measured itself.
 */
export function accountStepCost(tier: ModelCost | undefined, tokens: StepTokens): number | undefined {
  if (!tier) return undefined
  if (!Number.isFinite(tier.input) || tier.input < 0) return undefined
  if (!Number.isFinite(tier.output) || tier.output < 0) return undefined
  let amount = (tokens.input * tier.input + (tokens.output + tokens.reasoning) * tier.output) / 1_000_000
  if (tier.cache && Number.isFinite(tier.cache.read) && tier.cache.read >= 0) {
    amount += (tokens.cacheRead * tier.cache.read) / 1_000_000
  }
  if (tier.cache && Number.isFinite(tier.cache.write) && tier.cache.write >= 0) {
    amount += (tokens.cacheWrite * tier.cache.write) / 1_000_000
  }
  return amount
}

export interface RouterEvent {
  type: string
  data?: any
}

/** Per-session token counters and financial costs accumulated from finished steps. */
interface SessionUsage {
  sessionID: string
  model?: string
  steps: number
  tokens: StepTokens
  /** Key `${basis}:${currency}` → amount; a step lands in exactly one bucket. */
  costs: Map<string, number>
  updatedAt: number
}

interface Registration {
  dispose?(): Promise<void> | void
}

export interface PluginContext {
  options?: Record<string, unknown>
  model: {
    list(input?: { types?: string[] }): Promise<{ data: ModelInfo[] }>
  }
  /** Test/embedder override; production uses authenticated server-side account APIs. */
  pricing?: {
    load(signal: AbortSignal): Promise<AccountSnapshot[]>
  }
  provider?: {
    list(): Promise<{ data: AccountProvider[] }>
  }
  integration?: {
    connection: {
      active(integrationID: string): Promise<unknown>
      resolve(connection: unknown): Promise<unknown>
    }
  }
  session: {
    get(input: { sessionID: string }): Promise<{ model?: ModelRef }>
    switchModel(input: { sessionID: string; model: ModelRef }): Promise<void>
    synthetic(input: {
      sessionID: string
      text: string
      description?: string
      metadata?: Record<string, unknown>
      resume?: boolean
    }): Promise<unknown>
    hook(name: string, callback: (event: any) => void | Promise<void>): Promise<Registration>
  }
  event: {
    subscribe(options: { signal: AbortSignal; types?: string[] }): AsyncIterable<RouterEvent>
  }
  rpc?: {
    register(definition: unknown, handlers: Record<string, (input: any) => Promise<unknown>>): Promise<Registration>
  }
  storage?: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
  }
}

const STRATEGIES = new Set<Strategy>(["free-fastest", "fastest", "cheapest", "manual"])
const STORAGE_KEY = "router-options-v1"
/** Display-only ЦБ РФ orientation: cached rates stay fresh for ~6 hours. */
const CBR_TTL_MS = 6 * 60 * 60_000
/** After a failed fetch the next attempt waits ~15 minutes; stale rates keep their date. */
const CBR_RETRY_MS = 15 * 60_000
/** Public price listings are re-fetched at most once per ~6 hours per provider. */
const PUBLIC_TTL_MS = 6 * 60 * 60_000
/** After a failed public discovery the next attempt waits ~30 minutes. */
const PUBLIC_RETRY_MS = 30 * 60_000
const CONTINUE_TEXT =
  "The previous model provider became unavailable. Continue the existing task using the conversation and tool results already present. Do not repeat completed side effects."
const EVENT_TYPES = [
  "provider.updated",
  "model.updated",
  "credential.updated",
  "credential.switched",
  "integration.updated",
  "config.updated",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.execution.started",
  "session.execution.failed",
  "session.execution.succeeded",
  "session.execution.interrupted",
  "session.deleted",
]

export function modelKey(ref: ModelRef): string {
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`
}

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.providerID === b.providerID && a.id === b.id && a.variant === b.variant
}

function sameRouteModel(a: ModelRef, b: ModelRef, automatic: boolean): boolean {
  return (
    a.providerID === b.providerID &&
    a.id === b.id &&
    (automatic || a.variant === b.variant)
  )
}

function parseRef(value: string | ModelRef): ModelRef | undefined {
  if (typeof value !== "string") {
    return typeof value?.providerID === "string" && typeof value?.id === "string"
      ? {
          providerID: value.providerID,
          id: value.id,
          ...(typeof value.variant === "string" && value.variant
            ? { variant: value.variant }
            : {}),
        }
      : undefined
  }
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined
  const providerID = value.slice(0, separator)
  const [id, variant] = value.slice(separator + 1).split("#", 2)
  return id ? { providerID, id, ...(variant ? { variant } : {}) } : undefined
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function strategy(value: unknown, fallback: Strategy): Strategy {
  return typeof value === "string" && STRATEGIES.has(value as Strategy)
    ? (value as Strategy)
    : fallback
}

export function normalizeRouterOptions(value: unknown): RouterOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const input = value as Record<string, unknown>
  const result: RouterOptions = {}
  /** Record keys come from user input; "__proto__" must never become a key. */
  const safeKey = (key: string) => key.trim().slice(0, 80)
  const usable = (key: string) => key !== "" && key !== "__proto__"
  for (const key of ["enabled", "autoDiscover", "resumeAfterFailover", "cbrOrientation", "askBeforeOverride"] as const) {
    if (typeof input[key] === "boolean") result[key] = input[key]
  }
  if (STRATEGIES.has(input.strategy as Strategy)) result.strategy = input.strategy as Strategy
  if (typeof input.defaultGroup === "string" && input.defaultGroup.trim()) {
    result.defaultGroup = input.defaultGroup.trim().slice(0, 80)
  }
  for (const key of ["cooldownMs", "metricAlpha", "rescanIntervalMs"] as const) {
    if (typeof input[key] === "number" && Number.isFinite(input[key]) && input[key] > 0) {
      result[key] = input[key]
    }
  }
  if (Array.isArray(input.disabledModels)) {
    result.disabledModels = [
      ...new Set(
        input.disabledModels.flatMap((value) => {
          const ref = typeof value === "string" ? parseRef(value) : undefined
          return ref ? [`${ref.providerID}/${ref.id}`] : []
        }),
      ),
    ].slice(0, 10_000)
  }
  if (input.groups && typeof input.groups === "object" && !Array.isArray(input.groups)) {
    const groups: Record<string, GroupOptions> = {}
    for (const [rawName, value] of Object.entries(input.groups).slice(0, 100)) {
      const name = safeKey(rawName)
      if (!usable(name) || !value || typeof value !== "object" || Array.isArray(value)) continue
      const group = value as GroupOptions
      if (!Array.isArray(group.models)) continue
      const models = group.models.flatMap((model) => {
        const ref = parseRef(model)
        return ref ? [ref] : []
      })
      groups[name] = {
        models: models.slice(0, 1_000),
        ...(STRATEGIES.has(group.strategy as Strategy)
          ? { strategy: group.strategy as Strategy }
          : {}),
      }
    }
    result.groups = groups
  }
  if (
    input.accountThresholds &&
    typeof input.accountThresholds === "object" &&
    !Array.isArray(input.accountThresholds)
  ) {
    const thresholds: Record<string, AccountThreshold> = {}
    for (const [rawProvider, value] of Object.entries(input.accountThresholds).slice(0, 100)) {
      const providerID = safeKey(rawProvider)
      if (!usable(providerID) || !value || typeof value !== "object" || Array.isArray(value)) continue
      const entry = value as Record<string, unknown>
      const threshold: AccountThreshold = {}
      if (
        typeof entry.minBalance === "number" &&
        Number.isFinite(entry.minBalance) &&
        entry.minBalance >= 0
      ) {
        threshold.minBalance = entry.minBalance
      }
      if (entry.action === "warn" || entry.action === "exclude") threshold.action = entry.action
      // Entries without at least one value are dropped, so configure can clear them.
      if (threshold.minBalance !== undefined) {
        thresholds[providerID] = threshold
      }
    }
    result.accountThresholds = thresholds
  }
  if (
    input.priceLimits &&
    typeof input.priceLimits === "object" &&
    !Array.isArray(input.priceLimits)
  ) {
    const limits: Record<string, PriceLimits> = {}
    for (const [rawCurrency, value] of Object.entries(input.priceLimits).slice(0, 50)) {
      const currency = rawCurrency.trim().toUpperCase().slice(0, 3)
      if (
        !/^[A-Z]{3}$/u.test(currency) ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        continue
      }
      const entry = value as Record<string, unknown>
      const bound: PriceLimits = {}
      for (const key of ["inputMin", "inputMax", "outputMin", "outputMax"] as const) {
        if (typeof entry[key] === "number" && Number.isFinite(entry[key]) && entry[key] >= 0) {
          bound[key] = entry[key]
        }
      }
      if (entry.action === "warn" || entry.action === "exclude") bound.action = entry.action
      // Entries without at least one bound are dropped, so configure can clear them.
      if (
        bound.inputMin !== undefined ||
        bound.inputMax !== undefined ||
        bound.outputMin !== undefined ||
        bound.outputMax !== undefined
      ) {
        limits[currency] = bound
      }
    }
    result.priceLimits = limits
  }
  if (
    input.providerSites &&
    typeof input.providerSites === "object" &&
    !Array.isArray(input.providerSites)
  ) {
    const sites: Record<string, string> = {}
    for (const [rawProvider, value] of Object.entries(input.providerSites).slice(0, 50)) {
      const providerID = safeKey(rawProvider)
      if (!usable(providerID)) continue
      const site = normalizeSiteURL(value)
      // Invalid addresses are dropped, so configure can also clear them.
      if (site) sites[providerID] = site
    }
    result.providerSites = sites
  }
  return result
}

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function metric(): ModelMetrics {
  return { successes: 0, failures: 0, totalCostUSD: 0, generatedTokens: 0 }
}

function ema(previous: number | undefined, value: number, alpha: number): number {
  return previous === undefined ? value : previous * (1 - alpha) + value * alpha
}

function isFree(model: ModelInfo): boolean {
  return (
    Array.isArray(model.cost) &&
    model.cost.length > 0 &&
    model.cost.every(
      (tier) =>
        tier.input === 0 &&
        tier.output === 0 &&
        (tier.cache?.read ?? 0) === 0 &&
        (tier.cache?.write ?? 0) === 0,
    )
  )
}

interface ComparableCost {
  currency: string
  value: number
}

function catalogCost(model: ModelInfo): ComparableCost | undefined {
  const tier = model.cost?.[0]
  return tier
    ? { currency: model.costCurrency ?? "USD", value: tier.input + tier.output }
    : undefined
}

function actualCostPerMillion(metrics: ModelMetrics): number | undefined {
  return metrics.generatedTokens > 0
    ? (metrics.totalCostUSD / metrics.generatedTokens) * 1_000_000
    : undefined
}

function candidateCost(candidate: Candidate, metrics: ReadonlyMap<string, ModelMetrics>): ComparableCost | undefined {
  const catalog = catalogCost(candidate.info)
  const actual = actualCostPerMillion(metrics.get(modelKey(candidate)) ?? metric())
  // OpenCode reports measured cost in USD. Never reinterpret it as a non-USD account tariff.
  if (actual !== undefined && (!catalog || catalog.currency === "USD")) {
    return { currency: "USD", value: actual }
  }
  return catalog
}

export interface ThresholdEvaluation {
  /** Providers whose confirmed balance dropped below the configured minimum. */
  lowBalance: Set<string>
  /** "providerID/modelID" keys whose confirmed account price is outside configured limits. */
  priceBreached: Set<string>
  /** Keys removed from routing while the matching action is "exclude"; restored automatically. */
  excluded: Set<string>
}

/**
 * Guardrails are compared only against values confirmed by account APIs and
 * only within a single currency: balance thresholds use the account currency,
 * price limits are keyed by the price currency and apply to every provider.
 * Models without a confirmed account price are never flagged or excluded,
 * and nothing is converted by an assumed exchange rate.
 */
export function evaluateGuardrails(
  models: readonly ModelInfo[],
  accounts: ReadonlyMap<string, AccountSnapshot>,
  accountThresholds: Record<string, AccountThreshold> = {},
  priceLimits: Record<string, PriceLimits> = {},
): ThresholdEvaluation {
  const lowBalance = new Set<string>()
  const priceBreached = new Set<string>()
  const excluded = new Set<string>()
  for (const [providerID, threshold] of Object.entries(accountThresholds)) {
    const snapshot = accounts.get(providerID)
    const balance = snapshot?.balance
    // Without a confirmed balance in a known currency the threshold has no meaning.
    if (!balance || threshold.minBalance === undefined) continue
    if (balance.amount >= threshold.minBalance) continue
    lowBalance.add(providerID)
    if (threshold.action !== "exclude") continue
    for (const model of models) {
      if (model.providerID === providerID) excluded.add(`${model.providerID}/${model.id}`)
    }
  }
  for (const model of models) {
    // Only account-confirmed prices participate; unknown prices are never guessed.
    if (model.priceState === undefined) continue
    const tier = model.cost?.[0]
    const limits = tier ? priceLimits[model.costCurrency ?? "USD"] : undefined
    if (!tier || !limits) continue
    const breached =
      (limits.inputMax !== undefined && tier.input > limits.inputMax) ||
      (limits.outputMax !== undefined && tier.output > limits.outputMax) ||
      (limits.inputMin !== undefined && tier.input < limits.inputMin) ||
      (limits.outputMin !== undefined && tier.output < limits.outputMin)
    if (!breached) continue
    const key = `${model.providerID}/${model.id}`
    priceBreached.add(key)
    if (limits.action === "exclude") excluded.add(key)
  }
  return { lowBalance, priceBreached, excluded }
}

export function isLimitError(error: any): boolean {
  const status = error?.status
  if (status === 402 || status === 429) return true
  const type = typeof error?.type === "string" ? error.type : ""
  const message = typeof error?.message === "string" ? error.message : ""
  return /quota|rate.?limit|insufficient.?balance|payment.?required|billing.?limit|limit.?exceeded/iu.test(
    `${type} ${message}`,
  )
}

function retryAfterMs(error: any, fallback: number): number {
  const explicit = error?.retryAfterMs
  return typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0
    ? Math.min(explicit, 24 * 60 * 60_000)
    : fallback
}

/** Only exact model IDs are grouped automatically; manual groups are explicit. */
export function buildRouteGroups(
  models: ModelInfo[],
  options: RouterOptions = {},
  extraDisabled: ReadonlySet<string> = new Set(),
): Map<string, RouteGroup> {
  const result = new Map<string, RouteGroup>()
  const defaultStrategy = strategy(options.strategy, "free-fastest")
  const disabled = new Set(options.disabledModels ?? [])
  const enabled = models.filter((model) => model.enabled !== false)
  // Threshold exclusions behave like local disables: lookup keeps them, selection never does.
  const locallyDisabled = (model: ModelRef) => {
    const key = `${model.providerID}/${model.id}`
    return disabled.has(key) || extraDisabled.has(key)
  }

  if (options.autoDiscover !== false) {
    const buckets = new Map<string, ModelInfo[]>()
    for (const model of enabled) {
      if (model.type && model.type !== "chat") continue
      const bucket = buckets.get(model.id) ?? []
      bucket.push(model)
      buckets.set(model.id, bucket)
    }
    for (const [id, bucket] of buckets) {
      if (new Set(bucket.map((model) => model.providerID)).size < 2) continue
      result.set(`auto:${id}`, {
        name: `auto:${id}`,
        strategy: defaultStrategy,
        automatic: true,
        candidates: bucket.map((info, order) => ({
          providerID: info.providerID,
          id: info.id,
          variant: info.variant,
          info,
          order,
          disabled: locallyDisabled(info),
        })),
      })
    }
  }

  for (const [name, group] of Object.entries(options.groups ?? {})) {
    const candidates: Candidate[] = []
    for (const input of group?.models ?? []) {
      const ref = parseRef(input)
      if (!ref) continue
      const info = enabled.find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      if (!info) continue
      candidates.push({ ...ref, info, order: candidates.length, disabled: locallyDisabled(ref) })
    }
    if (candidates.length > 0) {
      result.set(name, {
        name,
        strategy: strategy(group.strategy, defaultStrategy),
        automatic: false,
        candidates,
      })
    }
  }
  return result
}

export function selectCandidate(
  group: RouteGroup,
  current: ModelRef | undefined,
  metrics: ReadonlyMap<string, ModelMetrics>,
  cooldowns: ReadonlyMap<string, number>,
  now: number,
  attempted: ReadonlySet<string> = new Set(),
  includeCurrent = true,
  cbr?: CbrRates,
): Candidate | undefined {
  const currentInfo = current
    ? group.candidates.find((candidate) => sameRouteModel(candidate, current, group.automatic))?.info
    : undefined
  let candidates = group.candidates.filter((candidate) => {
    const key = modelKey(candidate)
    if (candidate.disabled || candidate.info.enabled === false) return false
    if (!includeCurrent && current && sameRouteModel(candidate, current, group.automatic)) return false
    if (attempted.has(key) || (cooldowns.get(key) ?? 0) > now) return false
    if (currentInfo?.capabilities?.tools && !candidate.info.capabilities?.tools) return false
    if (
      group.automatic &&
      currentInfo?.limit?.context &&
      (candidate.info.limit?.context ?? 0) < currentInfo.limit.context
    ) {
      return false
    }
    return true
  })
  if (candidates.length === 0) return undefined

  if (group.strategy === "free-fastest") {
    const free = candidates.filter((candidate) => isFree(candidate.info))
    if (free.length > 0) candidates = free
  }
  if (group.strategy === "manual") return candidates[0]

  const compareSpeed = (a: Candidate, b: Candidate): number => {
    const left = metrics.get(modelKey(a)) ?? metric()
    const right = metrics.get(modelKey(b)) ?? metric()
    if ((left.successes === 0) !== (right.successes === 0)) return left.successes === 0 ? -1 : 1
    const speed = (right.outputTokensPerSecond ?? 0) - (left.outputTokensPerSecond ?? 0)
    if (speed !== 0) return speed
    const ttfb = (left.ttfbMs ?? Number.POSITIVE_INFINITY) - (right.ttfbMs ?? Number.POSITIVE_INFINITY)
    if (ttfb !== 0) return ttfb
    const latency = (left.latencyMs ?? Number.POSITIVE_INFINITY) - (right.latencyMs ?? Number.POSITIVE_INFINITY)
    return latency || a.order - b.order
  }

  if (group.strategy === "cheapest") {
    const costs = new Map<Candidate, ComparableCost | undefined>(
      candidates.map((candidate) => [candidate, candidateCost(candidate, metrics)]),
    )
    const currencies = new Set(
      [...costs.values()].flatMap((cost) => cost ? [cost.currency] : []),
    )
    if (currencies.size === 1) {
      return [...candidates].sort((a, b) => {
        const cost = (costs.get(a)?.value ?? Number.POSITIVE_INFINITY) -
          (costs.get(b)?.value ?? Number.POSITIVE_INFINITY)
        return cost || compareSpeed(a, b)
      })[0]
    }
    if (currencies.size > 1) {
      // With the ЦБ РФ orientation explicitly enabled, mixed currencies are
      // compared through conversion at the official rate. The estimate is
      // approximate by nature: providers convert funds at their own rates, so
      // actual spend can differ; it orders candidates, it is not a quote.
      // If any priced currency lacks a loaded rate nothing is converted.
      if (cbr) {
        const rubles = new Map<Candidate, number>()
        let complete = true
        for (const candidate of candidates) {
          const cost = costs.get(candidate)
          if (!cost) {
            rubles.set(candidate, Number.POSITIVE_INFINITY)
            continue
          }
          const rate = cbr.rates[cost.currency]
          if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
            complete = false
            break
          }
          rubles.set(candidate, cost.value * rate)
        }
        if (complete) {
          return [...candidates].sort((a, b) => {
            const diff = (rubles.get(a) ?? Number.POSITIVE_INFINITY) -
              (rubles.get(b) ?? Number.POSITIVE_INFINITY)
            return diff || compareSpeed(a, b)
          })[0]
        }
      }
      // No other exchange-rate source is assumed: mixed currencies are never compared numerically.
      return [...candidates].sort((a, b) => {
        const known = Number(Boolean(costs.get(b))) - Number(Boolean(costs.get(a)))
        return known || compareSpeed(a, b)
      })[0]
    }
  }
  return [...candidates].sort(compareSpeed)[0]
}

/**
 * A pending "keep or override" question for one session: the router wants to
 * switch a manually chosen model but must not do it silently.
 */
export interface OverrideRequest {
  sessionID: string
  /** Model key ("providerID/id") the user chose by hand. */
  current: string
  /** Model key the router proposes instead. */
  proposed: string
  /** Full reference of the proposed candidate, resolved at switch time. */
  proposedRef: ModelRef
  group: string
  /** Epoch ms when the question was first asked for this current/proposed pair. */
  askedAt: number
}

export class ModelAutoRouter {
  readonly options: RouterOptions
  private readonly configuredOptions: RouterOptions
  private readonly ready: Promise<void>
  private configuring: Promise<void> = Promise.resolve()
  private readonly metrics = new Map<string, ModelMetrics>()
  private readonly usage = new Map<string, SessionUsage>()
  private readonly cooldowns = new Map<string, number>()
  private readonly steps = new Map<string, { model: ModelRef; started: number }>()
  private readonly requests = new Map<string, number>()
  private readonly pending = new Map<string, ModelRef>()
  private readonly attempts = new Map<string, Set<string>>()
  private readonly failovers = new Map<string, Promise<boolean>>()
  private readonly activity = new Map<string, number>()
  private readonly failedExecutions = new Set<string>()
  /** Model keys last set by the router itself, per session (ownership marks). */
  private readonly routerOwned = new Map<string, string>()
  /** Sessions where the user answered "keep my manual model"; value = model key. */
  private readonly pinnedManual = new Map<string, string>()
  /** Unresolved override questions, at most one per session. */
  private readonly overrideRequests = new Map<string, OverrideRequest>()
  private activityCounter = 0
  private readonly registrations: Registration[] = []
  private groups = new Map<string, RouteGroup>()
  private catalogModels: ModelInfo[] = []
  private models: ModelInfo[] = []
  private accounts: ReadonlyMap<string, AccountSnapshot> = new Map()
  private thresholds: ThresholdEvaluation = {
    lowBalance: new Set(),
    priceBreached: new Set(),
    excluded: new Set(),
  }
  private cbr: CbrRates | undefined
  private cbrFailedAt = 0
  private publicPricing = new Map<string, PublicSnapshot>()
  private readonly publicFailedAt = new Map<string, number>()
  private readonly publicSites = new Map<string, string>()
  private autoSites = new Map<string, string>()
  private vault: AccountVault | undefined
  private vaultProviders = new Set<string>()
  /** Live snapshot of provider IDs visible to the router (models + vault). */
  private knownProviderIDs: string[] = []
  private refreshing: Promise<void> | undefined
  private stopped = false
  private timer: ReturnType<typeof setInterval> | undefined

  private readonly ctx: PluginContext
  private readonly rpcDefinition?: unknown

  constructor(ctx: PluginContext, rpcDefinition?: unknown) {
    this.ctx = ctx
    this.rpcDefinition = rpcDefinition
    this.configuredOptions = normalizeRouterOptions(ctx.options)
    this.options = normalizeRouterOptions(this.configuredOptions)
    this.ready = this.init()
  }

  private async init(): Promise<void> {
    try {
      this.vault = await openAccountVault(this.ctx.storage)
    } catch {
      // Without a vault the OpenCode connections remain the only key source.
      this.vault = undefined
    }
    await this.loadOptions()
  }

  private report(message: string): void {
    console.error(`[opencode-model-autorouter] ${message}`)
  }

  private replaceOptions(options: RouterOptions): void {
    for (const key of Object.keys(this.options)) delete this.options[key as keyof RouterOptions]
    Object.assign(this.options, normalizeRouterOptions(options))
  }

  private async loadOptions(): Promise<void> {
    if (!this.ctx.storage) return
    try {
      const stored = await this.ctx.storage.get(STORAGE_KEY)
      if (!this.stopped && stored !== undefined) {
        this.replaceOptions(normalizeRouterOptions(stored))
        this.scheduleRescan()
      }
    } catch {
      if (!this.stopped) this.report("settings load failed")
    }
  }

  async configure(patch: Record<string, unknown>, reset = false) {
    const operation = this.configuring.then(async () => {
      await this.ready
      if (this.stopped) throw new Error("router is unavailable")
      const next = reset
        ? normalizeRouterOptions(this.configuredOptions)
        : normalizeRouterOptions({ ...this.options, ...patch })
      if (!reset && (patch.defaultGroup === null || patch.defaultGroup === "")) {
        delete next.defaultGroup
      }
      try {
        if (reset) await this.ctx.storage?.remove(STORAGE_KEY)
        else await this.ctx.storage?.set(STORAGE_KEY, next)
      } catch {
        if (!this.stopped) this.report("settings save failed")
        throw new Error("settings could not be saved")
      }
      if (this.stopped) throw new Error("router is unavailable")
      this.replaceOptions(next)
      if (next.enabled === false || next.resumeAfterFailover === false) this.pending.clear()
      // Turning the protection off invalidates pending keep-or-override questions.
      if (next.askBeforeOverride === false) this.overrideRequests.clear()
      this.models = withPublicPricing(
        withAccountPricing(this.catalogModels, this.accounts),
        this.publicPricing,
      )
      this.rebuildGroups()
      this.scheduleRescan()
      await this.refresh()
      return this.status()
    })
    this.configuring = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private alpha(): number {
    return Math.min(1, positiveNumber(this.options.metricAlpha, 0.25))
  }

  private metricFor(ref: ModelRef): ModelMetrics {
    const key = modelKey(ref)
    let value = this.metrics.get(key)
    if (!value) {
      value = metric()
      this.metrics.set(key, value)
    }
    return value
  }

  private touch(sessionID: string): number {
    const token = ++this.activityCounter
    this.activity.set(sessionID, token)
    return token
  }

  /** FIFO-bounds per-session maps so abandoned sessions cannot grow memory. */
  private capSessions<V>(map: Map<string, V>): void {
    while (map.size > 500) map.delete(map.keys().next().value!)
  }

  private groupFor(ref: ModelRef | undefined): RouteGroup | undefined {
    if (this.options.defaultGroup) {
      const selected = this.groups.get(this.options.defaultGroup)
      if (selected) return selected
    }
    if (!ref) return undefined
    return [...this.groups.values()].find((group) =>
      group.candidates.some((candidate) => sameRouteModel(candidate, ref, group.automatic)),
    )
  }

  /**
   * Resolves the account key server-side: the optional plugin vault wins over
   * OpenCode connections because storing a key here is an explicit user choice.
   * The value is never logged, stored in plain form, or exposed via RPC/GUI.
   */
  private async resolveAccountKey(provider: AccountProvider): Promise<AccountKey | undefined> {
    try {
      const vaultKey = await this.vault?.get(provider.id)
      if (vaultKey) return { value: vaultKey, source: "plugin" }
    } catch {
      // A broken vault record falls back to the OpenCode connection.
    }
    const integration = this.ctx.integration
    if (!integration) return undefined
    try {
      const connection = await integration.connection.active(provider.integrationID ?? provider.id)
      if (!connection) return undefined
      const credential = (await integration.connection.resolve(connection)) as
        | { type?: string; key?: string; access?: string }
        | undefined
      if (credential?.type === "key" && typeof credential.key === "string" && credential.key) {
        return { value: credential.key, source: "opencode" }
      }
      if (credential?.type === "oauth" && typeof credential.access === "string" && credential.access) {
        return { value: credential.access, source: "opencode" }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  private async updateAccounts(): Promise<void> {
    try {
      if (this.ctx.pricing) {
        const snapshots = await this.ctx.pricing.load(this.lifecycle.signal)
        if (this.stopped) return
        this.accounts = new Map(snapshots.map((snapshot) => [snapshot.providerID, snapshot]))
        return
      }
      const listed = this.ctx.provider ? await this.ctx.provider.list() : { data: [] as AccountProvider[] }
      // Best-effort public discovery addresses from OpenCode provider config; the
      // manual `providerSites` option always wins over these.
      const autoSites = new Map<string, string>()
      for (const provider of listed.data) {
        const site = extractProviderSite(provider)
        if (site) autoSites.set(provider.id, site)
      }
      this.autoSites = autoSites
      const vaultIDs = (await this.vault?.providers()) ?? []
      if (this.stopped) return
      this.vaultProviders = new Set(vaultIDs)
      // Snapshot of all provider IDs currently visible to the router.
      // Used by vault.set to reject typos/injection without a hardcoded allowlist.
      this.knownProviderIDs = [
        ...new Set([...listed.data.map((p) => p.id), ...vaultIDs]),
      ]
      const snapshots = await loadAccountSnapshots(
        globalThis.fetch,
        this.lifecycle.signal,
        // Dynamic roster: models + vault keys. No hardcoded provider list;
        // any provider visible to the router can receive a vault key.
        [...listed.data, ...vaultIDs.map((id) => ({ id }))],
        (provider) => this.resolveAccountKey(provider),
        this.accounts,
      )
      if (this.stopped) return
      this.accounts = new Map(snapshots.map((snapshot) => [snapshot.providerID, snapshot]))
    } catch {
      if (this.stopped || this.lifecycle.signal.aborted) return
      this.report("account refresh failed")
      // Cached account data is kept but never presented as fresh.
      this.accounts = new Map(
        [...this.accounts].map(([providerID, snapshot]) => [
          providerID,
          snapshot.state === "live" ? { ...snapshot, state: "stale" as const } : snapshot,
        ]),
      )
    }
  }

  /**
   * Unauthenticated public price discovery for providers with a known site
   * address (manual `providerSites` first, then OpenCode config `baseURL`).
   * Results are cached ~6 hours; failures retry after ~30 minutes and keep the
   * last successful listing as stale instead of presenting it as fresh.
   * Requests never carry credentials or account keys.
   */
  private async updatePublicPricing(): Promise<void> {
    const sites = new Map<string, string>()
    for (const [providerID, site] of this.autoSites) sites.set(providerID, site)
    for (const [providerID, site] of Object.entries(this.options.providerSites ?? {})) {
      sites.set(providerID, site)
    }
    // Providers without a configured address keep no cached public prices.
    for (const providerID of [...this.publicPricing.keys()]) {
      if (!sites.has(providerID)) this.publicPricing.delete(providerID)
    }
    for (const providerID of [...this.publicFailedAt.keys()]) {
      if (!sites.has(providerID)) this.publicFailedAt.delete(providerID)
    }
    // A new or changed address invalidates the cache and the failure backoff,
    // so a corrected site is probed immediately instead of after ~30 minutes.
    for (const [providerID, site] of sites) {
      if (this.publicSites.get(providerID) !== site) {
        this.publicPricing.delete(providerID)
        this.publicFailedAt.delete(providerID)
      }
    }
    for (const providerID of [...this.publicSites.keys()]) {
      if (!sites.has(providerID)) this.publicSites.delete(providerID)
    }
    for (const [providerID, site] of sites) this.publicSites.set(providerID, site)
    const now = Date.now()
    const pending = [...sites].filter(([providerID]) => {
      const cached = this.publicPricing.get(providerID)
      if (cached && now - cached.fetchedAt < PUBLIC_TTL_MS) return false
      const failed = this.publicFailedAt.get(providerID)
      if (failed && now - failed < PUBLIC_RETRY_MS) return false
      return true
    })
    // Bounded concurrency: at most four providers probed in parallel.
    const CHUNK = 4
    for (let index = 0; index < pending.length; index += CHUNK) {
      const batch = pending.slice(index, index + CHUNK)
      const results = await Promise.allSettled(
        batch.map(([providerID, site]) =>
          loadPublicPricing(globalThis.fetch, this.lifecycle.signal, providerID, site),
        ),
      )
      if (this.stopped) return
      results.forEach((result, position) => {
        const providerID = batch[position][0]
        if (result.status === "fulfilled") {
          this.publicPricing.set(providerID, result.value)
          this.publicFailedAt.delete(providerID)
          return
        }
        if (this.lifecycle.signal.aborted) return
        this.publicFailedAt.set(providerID, Date.now())
        const cached = this.publicPricing.get(providerID)
        if (cached && cached.state === "live") {
          this.publicPricing.set(providerID, { ...cached, state: "stale" })
        }
      })
    }
  }

  /** Threshold evaluation is recomputed from live account data on every rebuild. */
  private rebuildGroups(): void {
    this.thresholds = evaluateGuardrails(
      this.models,
      this.accounts,
      this.options.accountThresholds,
      this.options.priceLimits,
    )
    this.groups = buildRouteGroups(this.models, this.options, this.thresholds.excluded)
  }

  /**
   * Opt-in ЦБ РФ orientation: rates are shown as «≈» equivalents and, only
   * while the orientation is enabled, approximate mixed-currency comparison in
   * the "cheapest" ranking. Guardrails (price limits, balance thresholds) stay
   * strictly in the account/price currency and never use conversion.
   */
  private async updateCbr(): Promise<void> {
    if (this.options.cbrOrientation !== true) {
      this.cbr = undefined
      this.cbrFailedAt = 0
      return
    }
    const now = Date.now()
    if (this.cbr && now - this.cbr.fetchedAt < CBR_TTL_MS) return
    if (this.cbrFailedAt && now - this.cbrFailedAt < CBR_RETRY_MS) return
    try {
      const rates = await loadCbrRates(globalThis.fetch, this.lifecycle.signal)
      if (!this.stopped) this.cbr = rates
    } catch {
      if (this.stopped || this.lifecycle.signal.aborted) return
      this.cbrFailedAt = Date.now()
      // Previous rates stay with their published date; the status marks them stale.
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      await this.ready
      const [listed] = await Promise.allSettled([
        this.ctx.model.list({ types: ["chat"] }),
        this.updateAccounts(),
        this.updateCbr(),
        this.updatePublicPricing(),
      ])
      if (this.stopped) return
      if (listed.status === "fulfilled") this.catalogModels = listed.value.data
      else this.report("model scan failed")
      this.models = withPublicPricing(
        withAccountPricing(this.catalogModels, this.accounts),
        this.publicPricing,
      )
      this.rebuildGroups()
      this.refreshing = undefined
    })().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async switchModel(sessionID: string, candidate: Candidate): Promise<boolean> {
    if (this.stopped) return false
    try {
      await this.ctx.session.switchModel({
        sessionID,
        model: {
          providerID: candidate.providerID,
          id: candidate.id,
          variant: candidate.variant,
        },
      })
      // Mark the model as router-owned so the next prompt is not treated as a
      // manual choice, and drop any stale keep-pin for this session.
      this.routerOwned.set(sessionID, modelKey(candidate))
      this.pinnedManual.delete(sessionID)
      this.capSessions(this.routerOwned)
      return !this.stopped
    } catch {
      if (!this.stopped) this.report("model switch failed")
      return false
    }
  }

  private async routePrompt(event: any): Promise<void> {
    const sessionID = event?.sessionID
    if (this.stopped || this.options.enabled === false || typeof sessionID !== "string") return
    if (event?.metadata?.source === "opencode-model-autorouter") return
    const token = this.touch(sessionID)
    this.pending.delete(sessionID)
    this.attempts.delete(sessionID)
    this.failedExecutions.delete(sessionID)
    try {
      const session = await this.ctx.session.get({ sessionID })
      if (this.stopped || this.activity.get(sessionID) !== token) return
      const group = this.groupFor(session.model)
      if (!group) return
      const currentKey = session.model ? modelKey(session.model) : undefined
      // The user answered "keep" for this exact model: never reroute it.
      if (currentKey !== undefined && this.pinnedManual.get(sessionID) === currentKey) return
      const candidate = selectCandidate(
        group,
        session.model,
        this.metrics,
        this.cooldowns,
        Date.now(),
        new Set(),
        true,
        this.cbr,
      )
      if (
        candidate &&
        (!session.model || !sameRouteModel(candidate, session.model, group.automatic))
      ) {
        // A model the router did not set is an explicit user/config choice:
        // ask before overriding instead of hijacking it silently.
        if (
          this.options.askBeforeOverride !== false &&
          currentKey !== undefined &&
          this.routerOwned.get(sessionID) !== currentKey
        ) {
          await this.requestOverride(sessionID, session.model!, candidate, group)
          return
        }
        await this.switchModel(sessionID, candidate)
      }
    } catch {
      if (!this.stopped) this.report("request routing failed")
    }
  }

  /**
   * Registers a "keep or override" question for a manually chosen model and
   * announces it once per current/proposed pair with a synthetic notice.
   * No resume: the user's prompt keeps running on their chosen model.
   */
  private async requestOverride(
    sessionID: string,
    current: ModelRef,
    candidate: Candidate,
    group: RouteGroup,
  ): Promise<void> {
    const existing = this.overrideRequests.get(sessionID)
    const currentKey = modelKey(current)
    const proposedKey = modelKey(candidate)
    const reused =
      existing !== undefined &&
      existing.current === currentKey &&
      existing.proposed === proposedKey
    const request: OverrideRequest = {
      sessionID,
      current: currentKey,
      proposed: proposedKey,
      proposedRef: {
        providerID: candidate.providerID,
        id: candidate.id,
        variant: candidate.variant,
      },
      group: group.name,
      askedAt: reused ? existing!.askedAt : Date.now(),
    }
    this.overrideRequests.set(sessionID, request)
    this.capSessions(this.overrideRequests)
    if (reused || this.stopped) return
    try {
      await this.ctx.session.synthetic({
        sessionID,
        text:
          `Маршрутизатор предлагает ${proposedKey} вместо выбранной вручную ${currentKey}. ` +
          "Ответьте в GUI плагина (панель «Защита ручного выбора»): оставить или переключить.",
        description: "Manual model choice: keep or override?",
        metadata: {
          source: "opencode-model-autorouter",
          kind: "override-request",
          current: currentKey,
          proposed: proposedKey,
        },
      })
    } catch {
      if (!this.stopped) this.report("override request notice failed")
    }
  }

  private noteRequest(event: any): void {
    if (typeof event?.sessionID !== "string" || !event.model) return
    const key = `${event.sessionID}:${event.kind}:${modelKey(event.model)}`
    this.requests.set(key, performance.now())
    if (this.requests.size > 1_000) this.requests.delete(this.requests.keys().next().value!)
  }

  private async noteResponse(event: any): Promise<void> {
    if (
      typeof event?.sessionID !== "string" ||
      event.kind !== "primary" ||
      !event.model ||
      !event.response
    ) {
      return
    }
    const key = `${event.sessionID}:${event.kind}:${modelKey(event.model)}`
    const started = this.requests.get(key)
    this.requests.delete(key)
    if (started !== undefined && event.response.status < 400) {
      const metrics = this.metricFor(event.model)
      metrics.ttfbMs = ema(metrics.ttfbMs, performance.now() - started, this.alpha())
    }
    if (isLimitError({ status: event.response.status })) {
      await this.failover(event.sessionID, event.model, {
        status: event.response.status,
        retryAfterMs: parseRetryAfter(event.response.headers),
      })
    }
  }

  private async failover(sessionID: string, current: ModelRef, error: any): Promise<boolean> {
    if (this.stopped || this.options.enabled === false || !isLimitError(error)) return false
    const running = this.failovers.get(sessionID)
    if (running) return running

    const key = modelKey(current)
    if (this.attempts.get(sessionID)?.has(key)) {
      return this.pending.has(sessionID) || this.options.resumeAfterFailover === false
    }
    const token = this.activity.get(sessionID) ?? this.touch(sessionID)
    const operation = (async () => {
      const group = this.groupFor(current)
      if (!group) return false
      this.cooldowns.set(
        key,
        Date.now() + retryAfterMs(error, positiveNumber(this.options.cooldownMs, 60_000)),
      )
      const attempted = this.attempts.get(sessionID) ?? new Set<string>()
      attempted.add(key)
      this.attempts.set(sessionID, attempted)
      const candidate = selectCandidate(
        group,
        current,
        this.metrics,
        this.cooldowns,
        Date.now(),
        attempted,
        false,
        this.cbr,
      )
      if (!candidate || !(await this.switchModel(sessionID, candidate))) return false
      if (
        this.stopped ||
        this.options.enabled === false ||
        this.activity.get(sessionID) !== token
      ) {
        return false
      }
      if (this.options.resumeAfterFailover !== false) {
        this.pending.set(sessionID, {
          providerID: candidate.providerID,
          id: candidate.id,
          variant: candidate.variant,
        })
      }
      return true
    })()
    this.failovers.set(sessionID, operation)
    try {
      return await operation
    } finally {
      if (this.failovers.get(sessionID) === operation) this.failovers.delete(sessionID)
    }
  }

  private async retry(event: any): Promise<void> {
    if (typeof event?.sessionID !== "string" || !event.model) return
    const switched = await this.failover(event.sessionID, event.model, event.error)
    if (this.options.resumeAfterFailover !== false && switched) {
      // The current execution must end before a synthetic continuation can run.
      event.decision = { retry: false }
    }
  }

  private stepStarted(data: any): void {
    if (typeof data?.sessionID !== "string" || typeof data?.assistantMessageID !== "string") return
    const key = `${data.sessionID}:${data.assistantMessageID}`
    this.steps.set(key, { model: data.model, started: performance.now() })
    if (this.steps.size > 1_000) this.steps.delete(this.steps.keys().next().value!)
  }

  private stepFinished(data: any, failed: boolean): void {
    const key = `${data?.sessionID}:${data?.assistantMessageID}`
    const started = this.steps.get(key)
    this.steps.delete(key)
    if (!started?.model) return
    const metrics = this.metricFor(started.model)
    const elapsed = Math.max(1, performance.now() - started.started)
    if (failed) {
      metrics.failures++
      return
    }
    metrics.successes++
    metrics.latencyMs = ema(metrics.latencyMs, elapsed, this.alpha())
    const generated = Math.max(0, (data.tokens?.output ?? 0) + (data.tokens?.reasoning ?? 0))
    metrics.generatedTokens += generated
    metrics.totalCostUSD += Number.isFinite(data.cost) ? Math.max(0, data.cost) : 0
    this.recordUsage(data, started.model)
    if (generated > 0) {
      metrics.outputTokensPerSecond = ema(
        metrics.outputTokensPerSecond,
        (generated * 1000) / elapsed,
        this.alpha(),
      )
    }
    this.cooldowns.delete(modelKey(started.model))
  }

  /**
   * Real-time usage statistics: token counters per session plus the financial
   * cost of the step. The cost basis is the confirmed account tariff of the
   * step's model (account currency); without one, the cost OpenCode measured
   * itself (USD); without either, the step adds no cost row — never invented.
   */
  private recordUsage(data: any, model: ModelRef): void {
    const sessionID = data?.sessionID
    if (typeof sessionID !== "string" || sessionID === "") return
    const tokens = parseStepTokens(data)
    let entry = this.usage.get(sessionID)
    if (!entry) {
      entry = {
        sessionID,
        steps: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        costs: new Map(),
        updatedAt: 0,
      }
      this.usage.set(sessionID, entry)
      if (this.usage.size > 500) this.usage.delete(this.usage.keys().next().value!)
    }
    entry.model = modelKey(model)
    entry.steps += 1
    entry.tokens.input += tokens.input
    entry.tokens.output += tokens.output
    entry.tokens.reasoning += tokens.reasoning
    entry.tokens.cacheRead += tokens.cacheRead
    entry.tokens.cacheWrite += tokens.cacheWrite
    const priced = this.accounts.get(model.providerID)?.costs.get(model.id)
    const accountCost = priced ? accountStepCost(priced.cost[0], tokens) : undefined
    if (accountCost !== undefined && priced) {
      const key = `account:${priced.currency}`
      entry.costs.set(key, (entry.costs.get(key) ?? 0) + accountCost)
    } else if (typeof data?.cost === "number" && Number.isFinite(data.cost) && data.cost >= 0) {
      const key = "measured:USD"
      entry.costs.set(key, (entry.costs.get(key) ?? 0) + data.cost)
    }
    entry.updatedAt = Date.now()
  }

  private usageStatus() {
    const costRows = (costs: ReadonlyMap<string, number>) =>
      [...costs.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, amount]) => ({
          amount,
          currency: key.slice(key.indexOf(":") + 1),
          basis: key.startsWith("account:") ? ("account" as const) : ("measured" as const),
        }))
    const totals = new Map<string, number>()
    for (const entry of this.usage.values()) {
      for (const [key, amount] of entry.costs) {
        totals.set(key, (totals.get(key) ?? 0) + amount)
      }
    }
    const sessions = [...this.usage.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200)
      .map((entry) => ({
        sessionID: entry.sessionID,
        ...(entry.model === undefined ? {} : { model: entry.model }),
        steps: entry.steps,
        tokens: { ...entry.tokens },
        costs: costRows(entry.costs),
        updatedAt: new Date(entry.updatedAt).toISOString(),
      }))
    return { sessions, totals: costRows(totals) }
  }

  private canContinue(): boolean {
    return (
      !this.stopped &&
      this.options.enabled !== false &&
      this.options.resumeAfterFailover !== false
    )
  }

  private async executionFailed(data: any): Promise<void> {
    const sessionID = data?.sessionID
    if (
      typeof sessionID !== "string" ||
      !isLimitError(data?.error) ||
      !this.canContinue() ||
      this.failedExecutions.has(sessionID)
    ) {
      return
    }
    this.failedExecutions.add(sessionID)
    const token = this.activity.get(sessionID) ?? this.touch(sessionID)
    try {
      let pending = this.pending.get(sessionID)
      if (!pending) {
        const session = await this.ctx.session.get({ sessionID })
        if (!this.canContinue() || this.activity.get(sessionID) !== token) {
          return
        }
        pending = this.pending.get(sessionID)
        if (
          !pending &&
          session.model &&
          (await this.failover(sessionID, session.model, data.error))
        ) {
          pending = this.pending.get(sessionID)
        }
      }
      if (
        !pending ||
        !this.canContinue() ||
        this.activity.get(sessionID) !== token
      ) {
        return
      }
      this.pending.delete(sessionID)
      await this.ctx.session.synthetic({
        sessionID,
        text: CONTINUE_TEXT,
        description: "Continue after model provider failover",
        metadata: { source: "opencode-model-autorouter", providerID: pending.providerID, modelID: pending.id },
        resume: true,
      })
    } catch {
      if (!this.stopped) this.report("automatic continuation failed")
    }
  }

  private async handleEvent(event: RouterEvent): Promise<void> {
    const data = event.data
    switch (event.type) {
      case "provider.updated":
      case "model.updated":
      case "credential.updated":
      case "credential.switched":
      case "integration.updated":
      case "config.updated":
        await this.refresh()
        break
      case "session.step.started":
        this.stepStarted(data)
        break
      case "session.step.ended":
        this.stepFinished(data, false)
        break
      case "session.step.failed":
        this.stepFinished(data, true)
        break
      case "session.execution.started":
        if (typeof data?.sessionID === "string") {
          this.touch(data.sessionID)
          this.failedExecutions.delete(data.sessionID)
        }
        break
      case "session.execution.failed":
        await this.executionFailed(data)
        break
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        this.pending.delete(data?.sessionID)
        this.attempts.delete(data?.sessionID)
        this.failedExecutions.delete(data?.sessionID)
        this.activity.delete(data?.sessionID)
        break
      case "session.deleted":
        this.pending.delete(data?.sessionID)
        this.attempts.delete(data?.sessionID)
        this.failedExecutions.delete(data?.sessionID)
        this.activity.delete(data?.sessionID)
        this.usage.delete(data?.sessionID)
        break
    }
  }

  status() {
    const now = Date.now()
    const snapshot = (ref: ModelRef, info: ModelInfo) => {
      const key = modelKey(ref)
      const current = this.metrics.get(key) ?? metric()
      const actualCost = actualCostPerMillion(current)
      return {
        model: key,
        free: isFree(info),
        available: (this.cooldowns.get(key) ?? 0) <= now,
        cooldownMs: Math.max(0, (this.cooldowns.get(key) ?? 0) - now),
        ...current,
        ...(actualCost === undefined ? {} : { actualCostPerMillionUSD: actualCost }),
      }
    }
    const disabled = new Set(this.options.disabledModels ?? [])
    const memberships = new Map<string, string[]>()
    for (const group of this.groups.values()) {
      for (const candidate of group.candidates) {
        const key = `${candidate.providerID}/${candidate.id}`
        const names = memberships.get(key) ?? []
        if (!names.includes(group.name)) names.push(group.name)
        memberships.set(key, names)
      }
    }
    return defined({
      enabled: this.options.enabled !== false,
      autoDiscover: this.options.autoDiscover !== false,
      strategy: strategy(this.options.strategy, "free-fastest"),
      defaultGroup: this.options.defaultGroup,
      resumeAfterFailover: this.options.resumeAfterFailover !== false,
      askBeforeOverride: this.options.askBeforeOverride !== false,
      cooldownMs: positiveNumber(this.options.cooldownMs, 60_000),
      metricAlpha: this.alpha(),
      rescanIntervalMs: positiveNumber(this.options.rescanIntervalMs, 60_000),
      accountThresholds: Object.fromEntries(
        Object.entries(this.options.accountThresholds ?? {}).map(([providerID, threshold]) => [
          providerID,
          defined({
            minBalance: threshold.minBalance,
            action: threshold.action,
          }),
        ]),
      ),
      priceLimits: Object.fromEntries(
        Object.entries(this.options.priceLimits ?? {}).map(([currency, bound]) => [
          currency,
          defined({
            inputMin: bound.inputMin,
            inputMax: bound.inputMax,
            outputMin: bound.outputMin,
            outputMax: bound.outputMax,
            action: bound.action,
          }),
        ]),
      ),
      cbrOrientation: this.options.cbrOrientation === true,
      providerSites: { ...(this.options.providerSites ?? {}) },
      publicPricing: [...this.publicPricing.values()].map((snapshot) => ({
        providerID: snapshot.providerID,
        origin: snapshot.origin,
        state: snapshot.state,
        fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
        stale: now - snapshot.fetchedAt > PUBLIC_TTL_MS,
        matchedModels: this.models.filter(
          (model) =>
            model.providerID === snapshot.providerID &&
            (model.priceState === "public" || model.priceState === "public-stale"),
        ).length,
      })),
      cbr: this.cbr
        ? {
            date: this.cbr.date,
            fetchedAt: new Date(this.cbr.fetchedAt).toISOString(),
            stale: now - this.cbr.fetchedAt > CBR_TTL_MS,
            rates: { ...this.cbr.rates },
          }
        : undefined,
      accounts: [...this.accounts.values()].map((snapshot) => {
        const matched = this.models.filter(
          (model) =>
            model.providerID === snapshot.providerID &&
            (model.priceState === "live" || model.priceState === "stale"),
        ).length
        return defined({
          providerID: snapshot.providerID,
          state: snapshot.state,
          updatedAt: snapshot.updatedAt === undefined
            ? undefined
            : new Date(snapshot.updatedAt).toISOString(),
          pricingSupported: snapshot.pricingSupported,
          balanceSupported: snapshot.balanceSupported,
          matchedModels: matched,
          balance: snapshot.balance?.amount,
          balanceCurrency: snapshot.balance?.currency,
          lowBalance: this.thresholds.lowBalance.has(snapshot.providerID) || undefined,
          keySource: snapshot.keySource,
          pluginKey: this.vaultProviders.has(snapshot.providerID) || undefined,
        })
      }),
      disabledModels: [...disabled].sort(),
      overrideRequests: [...this.overrideRequests.values()].map((request) => ({
        sessionID: request.sessionID,
        current: request.current,
        proposed: request.proposed,
        group: request.group,
        askedAt: new Date(request.askedAt).toISOString(),
      })),
      pinnedModels: [...this.pinnedManual.entries()].map(([sessionID, model]) => ({
        sessionID,
        model,
      })),
      manualGroups: Object.entries(this.options.groups ?? {}).map(([name, group]) => ({
        name,
        strategy: strategy(group.strategy, strategy(this.options.strategy, "free-fastest")),
        models: group.models.flatMap((model) => {
          const ref = parseRef(model)
          return ref ? [modelKey(ref)] : []
        }),
      })),
      modelsDiscovered: this.models.length,
      usage: this.usageStatus(),
      models: this.models.map((info) => {
        const ref = { providerID: info.providerID, id: info.id }
        const key = modelKey(ref)
        return defined({
          ...snapshot(ref, info),
          providerID: info.providerID,
          id: info.id,
          name: info.name,
          enabled: info.enabled !== false,
          routingEnabled: info.enabled !== false && !disabled.has(key),
          priceLimitBreached: this.thresholds.priceBreached.has(key) || undefined,
          thresholdExcluded: this.thresholds.excluded.has(key) || undefined,
          variants: info.variants?.map((variant) => variant.id) ?? [],
          costCurrency: info.costCurrency,
          priceState: info.priceState,
          cost: info.cost?.map((tier) =>
            defined({
              tier: tier.tier ? { type: "context" as const, size: tier.tier.size } : undefined,
              input: tier.input,
              output: tier.output,
              cache: tier.cache
                ? defined({ read: tier.cache.read, write: tier.cache.write })
                : undefined,
            }),
          ),
          limit: info.limit
            ? defined({ context: info.limit.context, output: info.limit.output })
            : undefined,
          capabilities: info.capabilities
            ? defined({
                tools: info.capabilities.tools,
                input: info.capabilities.input,
                output: info.capabilities.output,
              })
            : undefined,
          groups: memberships.get(key) ?? [],
        })
      }),
      groups: [...this.groups.values()].map((group) => ({
        name: group.name,
        automatic: group.automatic,
        strategy: group.strategy,
        candidates: group.candidates.map((candidate) => snapshot(candidate, candidate.info)),
      })),
    })
  }

  private register(registration: Promise<Registration>): void {
    void registration
      .then((value) => {
        if (this.stopped) void value?.dispose?.()
        else this.registrations.push(value)
      })
      .catch(() => {
        if (!this.stopped) this.report("registration failed")
      })
  }

  private async watch(): Promise<void> {
    const signal = this.lifecycle.signal
    while (!signal.aborted) {
      try {
        for await (const event of this.ctx.event.subscribe({ signal, types: EVENT_TYPES })) {
          await this.handleEvent(event)
        }
      } catch {
        // Reconnect below unless cleanup started.
      }
      if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }

  private readonly lifecycle = new AbortController()

  private scheduleRescan(): void {
    if (this.stopped) return
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(
      () => void this.refresh(),
      positiveNumber(this.options.rescanIntervalMs, 60_000),
    )
    this.timer.unref?.()
  }

  start(): void {
    this.register(this.ctx.session.hook("prompt", (event) => this.routePrompt(event)))
    this.register(this.ctx.session.hook("model.request", (event) => this.noteRequest(event)))
    this.register(this.ctx.session.hook("http.response", (event) => this.noteResponse(event)))
    this.register(this.ctx.session.hook("retry", (event) => this.retry(event)))
    if (this.rpcDefinition && this.ctx.rpc?.register) {
      this.register(
        this.ctx.rpc.register(this.rpcDefinition, {
          status: async () => this.status(),
          rescan: async () => {
            await this.refresh()
            return this.status()
          },
          configure: async (input: Record<string, unknown> & { reset?: boolean }) => {
            const { reset = false, ...patch } = input
            return this.configure(patch, reset)
          },
          setAccountKey: async (input: { providerID: string; key: string }) => {
            await this.ready
            if (this.stopped) throw new Error("router is unavailable")
            if (!this.vault) throw new Error("plugin storage is unavailable")
            // The key is encrypted at rest and never echoed back or logged.
            // Dynamic validation: build a fresh roster from models + vault so
            // the call works even before the first refresh() completes.
            const listed = this.ctx.provider ? await this.ctx.provider.list() : { data: [] as Array<{ id: string }> }
            const vaultIDs = (await this.vault.providers()) ?? []
            const roster = [...new Set([...listed.data.map((p) => p.id), ...vaultIDs])]
            // A key for a provider without a confirmed account API has no
            // consumer: it could never be sent anywhere (keys go only to the
            // fixed account-API origins), so refuse it instead of storing dead
            // config. Same rule the GUI uses to hide the button.
            if (!accountCapable(input.providerID)) {
              throw new Error(
                `setAccountKey rejected: provider "${input.providerID}" has no confirmed account API, so a stored key would have no consumer`,
              )
            }
            await this.vault.set(input.providerID, input.key, roster)
            this.vaultProviders.add(input.providerID)
            // Directly update accounts so the new key is visible immediately,
            // without waiting for the debounced refresh() cycle. No background
            // refresh here: it would issue API requests that race with tests
            // checking request counts. The periodic rescan timer picks up
            // CBR/public pricing changes on its own cadence.
            await this.updateAccounts()
            this.models = withPublicPricing(
              withAccountPricing(this.catalogModels, this.accounts),
              this.publicPricing,
            )
            this.rebuildGroups()
            return { stored: true, providerID: input.providerID }
          },
          clearAccountKey: async (input: { providerID: string }) => {
            await this.ready
            if (this.stopped) throw new Error("router is unavailable")
            if (!this.vault) throw new Error("plugin storage is unavailable")
            const cleared = await this.vault.clear(input.providerID)
            if (cleared) this.vaultProviders.delete(input.providerID)
            // Direct update + rebuild, same pattern as setAccountKey to avoid
            // debounce returning a stale snapshot where the key still appears.
            // No background refresh here: updateAccounts already reflects the
            // cleared key, and a background refresh would issue API requests
            // that race with tests checking request counts.
            await this.updateAccounts()
            this.models = withPublicPricing(
              withAccountPricing(this.catalogModels, this.accounts),
              this.publicPricing,
            )
            this.rebuildGroups()
            return { cleared }
          },
          select: async (input: { sessionID: string; model: string }) => {
            await this.ready
            const ref = parseRef(input.model)
            const grouped = ref
              ? [...this.groups.values()]
                  .flatMap((group) => group.candidates)
                  .find((item) => !item.disabled && sameModel(item, ref))
              : undefined
            const info = ref
              ? this.models.find(
                  (item) =>
                    item.providerID === ref.providerID &&
                    item.id === ref.id &&
                    item.enabled !== false &&
                    !this.options.disabledModels?.includes(`${item.providerID}/${item.id}`) &&
                    !this.thresholds.excluded.has(`${item.providerID}/${item.id}`),
                )
              : undefined
            const candidate: Candidate | undefined = grouped
              ? grouped
              : ref && info
                ? { ...ref, info, order: 0 }
                : undefined
            if (!candidate || !(await this.switchModel(input.sessionID, candidate))) {
              throw new Error("model is unavailable")
            }
            const key = modelKey(candidate)
            // A GUI selection is a manual choice: pin it against rerouting and
            // resolve any pending keep-or-override question for the session.
            this.routerOwned.delete(input.sessionID)
            this.pinnedManual.set(input.sessionID, key)
            this.overrideRequests.delete(input.sessionID)
            this.capSessions(this.pinnedManual)
            return { selected: key }
          },
          resolveOverrideRequest: async (input: {
            sessionID: string
            action: "keep" | "override"
          }) => {
            await this.ready
            const request = this.overrideRequests.get(input.sessionID)
            if (!request) throw new Error("no override request for this session")
            if (input.action === "keep") {
              this.overrideRequests.delete(input.sessionID)
              this.pinnedManual.set(input.sessionID, request.current)
              this.capSessions(this.pinnedManual)
              return { resolved: "keep" as const, model: request.current, pinned: true }
            }
            const candidate = [...this.groups.values()]
              .flatMap((group) => group.candidates)
              .find((item) => !item.disabled && sameModel(item, request.proposedRef))
            // On failure the request stays registered so the user can retry.
            if (!candidate || !(await this.switchModel(input.sessionID, candidate))) {
              throw new Error("proposed model is unavailable")
            }
            this.overrideRequests.delete(input.sessionID)
            this.pinnedManual.delete(input.sessionID)
            return { resolved: "override" as const, model: modelKey(candidate), pinned: false }
          },
          releaseManualSelection: async (input: { sessionID: string }) => {
            await this.ready
            const released = this.pinnedManual.delete(input.sessionID)
            return { released }
          },
        }),
      )
    }
    void this.refresh()
    void this.watch()
    this.scheduleRescan()
  }

  cleanup(): void {
    if (this.stopped) return
    this.stopped = true
    this.lifecycle.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const registration of this.registrations.splice(0)) {
      void Promise.resolve(registration.dispose?.()).catch(() => {})
    }
    this.steps.clear()
    this.requests.clear()
    this.pending.clear()
    this.attempts.clear()
    this.failovers.clear()
    this.activity.clear()
    this.failedExecutions.clear()
    this.routerOwned.clear()
    this.pinnedManual.clear()
    this.overrideRequests.clear()
    this.cooldowns.clear()
    this.cbr = undefined
    this.cbrFailedAt = 0
    this.vault = undefined
    this.vaultProviders.clear()
  }
}

export function parseRetryAfter(headers: any): number | undefined {
  const milliseconds = headers?.get?.("retry-after-ms")
  const value = typeof milliseconds === "string" ? milliseconds : headers?.get?.("retry-after")
  if (typeof value !== "string") return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric * (typeof milliseconds === "string" ? 1 : 1000)
  }
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

export function setupModelAutoRouter(ctx: PluginContext, rpcDefinition?: unknown): () => void {
  const router = new ModelAutoRouter(ctx, rpcDefinition)
  router.start()
  return () => router.cleanup()
}
