import {
  loadAccountSnapshots,
  withAccountPricing,
  type AccountProvider,
  type AccountSnapshot,
  type ModelCost,
} from "./pricing.ts"

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
  priceState?: "live" | "stale"
}

interface GroupOptions {
  models: Array<string | ModelRef>
  strategy?: Strategy
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
  metricAlpha?: number
  rescanIntervalMs?: number
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

export interface RouterEvent {
  type: string
  data?: any
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
  for (const key of ["enabled", "autoDiscover", "resumeAfterFailover"] as const) {
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
      const name = rawName.trim().slice(0, 80)
      if (!name || !value || typeof value !== "object" || Array.isArray(value)) continue
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
): Map<string, RouteGroup> {
  const result = new Map<string, RouteGroup>()
  const defaultStrategy = strategy(options.strategy, "free-fastest")
  const disabled = new Set(options.disabledModels ?? [])
  const enabled = models.filter((model) => model.enabled !== false)
  const locallyDisabled = (model: ModelRef) => disabled.has(`${model.providerID}/${model.id}`)

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
      // No exchange-rate source is assumed: mixed currencies are never compared numerically.
      return [...candidates].sort((a, b) => {
        const known = Number(Boolean(costs.get(b))) - Number(Boolean(costs.get(a)))
        return known || compareSpeed(a, b)
      })[0]
    }
  }
  return [...candidates].sort(compareSpeed)[0]
}

export class ModelAutoRouter {
  readonly options: RouterOptions
  private readonly configuredOptions: RouterOptions
  private readonly ready: Promise<void>
  private configuring: Promise<void> = Promise.resolve()
  private readonly metrics = new Map<string, ModelMetrics>()
  private readonly cooldowns = new Map<string, number>()
  private readonly steps = new Map<string, { model: ModelRef; started: number }>()
  private readonly requests = new Map<string, number>()
  private readonly pending = new Map<string, ModelRef>()
  private readonly attempts = new Map<string, Set<string>>()
  private readonly failovers = new Map<string, Promise<boolean>>()
  private readonly activity = new Map<string, number>()
  private readonly failedExecutions = new Set<string>()
  private activityCounter = 0
  private readonly registrations: Registration[] = []
  private groups = new Map<string, RouteGroup>()
  private catalogModels: ModelInfo[] = []
  private models: ModelInfo[] = []
  private accounts: ReadonlyMap<string, AccountSnapshot> = new Map()
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
    this.ready = this.loadOptions()
  }

  private report(message: string): void {
    console.error(`[opecode-model-autorouter] ${message}`)
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
      this.models = withAccountPricing(this.catalogModels, this.accounts)
      this.groups = buildRouteGroups(this.models, this.options)
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

  /** Resolves the account key server-side; the value is never logged, stored, or exposed via RPC/GUI. */
  private async resolveAccountKey(integrationID: string): Promise<string | undefined> {
    const integration = this.ctx.integration
    if (!integration) return undefined
    try {
      const connection = await integration.connection.active(integrationID)
      if (!connection) return undefined
      const credential = (await integration.connection.resolve(connection)) as
        | { type?: string; key?: string; access?: string }
        | undefined
      if (credential?.type === "key" && typeof credential.key === "string" && credential.key) {
        return credential.key
      }
      if (credential?.type === "oauth" && typeof credential.access === "string" && credential.access) {
        return credential.access
      }
      return undefined
    } catch {
      return undefined
    }
  }

  private async updateAccounts(): Promise<void> {
    try {
      const snapshots = this.ctx.pricing
        ? await this.ctx.pricing.load(this.lifecycle.signal)
        : await loadAccountSnapshots(
            globalThis.fetch,
            this.lifecycle.signal,
            (this.ctx.provider ? await this.ctx.provider.list() : { data: [] }).data,
            (integrationID) => this.resolveAccountKey(integrationID),
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

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      await this.ready
      const [listed] = await Promise.allSettled([
        this.ctx.model.list({ types: ["chat"] }),
        this.updateAccounts(),
      ])
      if (this.stopped) return
      if (listed.status === "fulfilled") this.catalogModels = listed.value.data
      else this.report("model scan failed")
      this.models = withAccountPricing(this.catalogModels, this.accounts)
      this.groups = buildRouteGroups(this.models, this.options)
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
      return !this.stopped
    } catch {
      if (!this.stopped) this.report("model switch failed")
      return false
    }
  }

  private async routePrompt(event: any): Promise<void> {
    const sessionID = event?.sessionID
    if (this.stopped || this.options.enabled === false || typeof sessionID !== "string") return
    if (event?.metadata?.source === "opecode-model-autorouter") return
    const token = this.touch(sessionID)
    this.pending.delete(sessionID)
    this.attempts.delete(sessionID)
    this.failedExecutions.delete(sessionID)
    try {
      const session = await this.ctx.session.get({ sessionID })
      if (this.stopped || this.activity.get(sessionID) !== token) return
      const group = this.groupFor(session.model)
      if (!group) return
      const candidate = selectCandidate(
        group,
        session.model,
        this.metrics,
        this.cooldowns,
        Date.now(),
      )
      if (
        candidate &&
        (!session.model || !sameRouteModel(candidate, session.model, group.automatic))
      ) {
        await this.switchModel(sessionID, candidate)
      }
    } catch {
      if (!this.stopped) this.report("request routing failed")
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
    if (generated > 0) {
      metrics.outputTokensPerSecond = ema(
        metrics.outputTokensPerSecond,
        (generated * 1000) / elapsed,
        this.alpha(),
      )
    }
    this.cooldowns.delete(modelKey(started.model))
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
        metadata: { source: "opecode-model-autorouter", providerID: pending.providerID, modelID: pending.id },
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
      case "session.deleted":
        this.pending.delete(data?.sessionID)
        this.attempts.delete(data?.sessionID)
        this.failedExecutions.delete(data?.sessionID)
        this.activity.delete(data?.sessionID)
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
      cooldownMs: positiveNumber(this.options.cooldownMs, 60_000),
      metricAlpha: this.alpha(),
      rescanIntervalMs: positiveNumber(this.options.rescanIntervalMs, 60_000),
      accounts: [...this.accounts.values()].map((snapshot) => {
        const matched = this.models.filter(
          (model) => model.providerID === snapshot.providerID && model.priceState !== undefined,
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
        })
      }),
      disabledModels: [...disabled].sort(),
      manualGroups: Object.entries(this.options.groups ?? {}).map(([name, group]) => ({
        name,
        strategy: strategy(group.strategy, strategy(this.options.strategy, "free-fastest")),
        models: group.models.flatMap((model) => {
          const ref = parseRef(model)
          return ref ? [modelKey(ref)] : []
        }),
      })),
      modelsDiscovered: this.models.length,
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
                    !this.options.disabledModels?.includes(`${item.providerID}/${item.id}`),
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
            return { selected: modelKey(candidate) }
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
    this.cooldowns.clear()
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
