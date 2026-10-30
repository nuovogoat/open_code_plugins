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
  limit?: {
    context?: number
    output?: number
  }
  cost?: Array<{
    input: number
    output: number
    cache?: { read: number; write: number }
  }>
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
  cooldownMs?: number
  resumeAfterFailover?: boolean
  metricAlpha?: number
  rescanIntervalMs?: number
}

export interface Candidate extends ModelRef {
  info: ModelInfo
  order: number
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
}

const STRATEGIES = new Set<Strategy>(["free-fastest", "fastest", "cheapest", "manual"])
const CONTINUE_TEXT =
  "The previous model provider became unavailable. Continue the existing task using the conversation and tool results already present. Do not repeat completed side effects."
const EVENT_TYPES = [
  "provider.updated",
  "model.updated",
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
      ? { providerID: value.providerID, id: value.id, variant: value.variant }
      : undefined
  }
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined
  const providerID = value.slice(0, separator)
  const [id, variant] = value.slice(separator + 1).split("#", 2)
  return id ? { providerID, id, variant: variant || undefined } : undefined
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function strategy(value: unknown, fallback: Strategy): Strategy {
  return typeof value === "string" && STRATEGIES.has(value as Strategy)
    ? (value as Strategy)
    : fallback
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

function catalogCost(model: ModelInfo): number {
  const tier = model.cost?.[0]
  return tier ? tier.input + tier.output : Number.POSITIVE_INFINITY
}

function actualCostPerMillion(metrics: ModelMetrics): number | undefined {
  return metrics.generatedTokens > 0
    ? (metrics.totalCostUSD / metrics.generatedTokens) * 1_000_000
    : undefined
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
  const available = models.filter((model) => model.enabled !== false)

  if (options.autoDiscover !== false) {
    const buckets = new Map<string, ModelInfo[]>()
    for (const model of available) {
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
        })),
      })
    }
  }

  for (const [name, group] of Object.entries(options.groups ?? {})) {
    const candidates: Candidate[] = []
    for (const input of group?.models ?? []) {
      const ref = parseRef(input)
      if (!ref) continue
      const info = available.find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      if (!info) continue
      candidates.push({ ...ref, info, order: candidates.length })
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

  return [...candidates].sort((a, b) => {
    if (group.strategy === "cheapest") {
      const left = metrics.get(modelKey(a)) ?? metric()
      const right = metrics.get(modelKey(b)) ?? metric()
      const cost =
        (actualCostPerMillion(left) ?? catalogCost(a.info)) -
        (actualCostPerMillion(right) ?? catalogCost(b.info))
      if (cost !== 0) return cost
    }
    return compareSpeed(a, b)
  })[0]
}

export class ModelAutoRouter {
  readonly options: RouterOptions
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
  private models: ModelInfo[] = []
  private refreshing: Promise<void> | undefined
  private stopped = false
  private timer: ReturnType<typeof setInterval> | undefined

  private readonly ctx: PluginContext
  private readonly rpcDefinition?: unknown

  constructor(ctx: PluginContext, rpcDefinition?: unknown) {
    this.ctx = ctx
    this.rpcDefinition = rpcDefinition
    this.options = ctx.options ?? {}
  }

  private report(message: string): void {
    console.error(`[opecode-model-autorouter] ${message}`)
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

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      try {
        const { data: models } = await this.ctx.model.list({ types: ["chat"] })
        if (this.stopped) return
        this.models = models
        this.groups = buildRouteGroups(models, this.options)
      } catch {
        if (!this.stopped) this.report("model scan failed")
      } finally {
        this.refreshing = undefined
      }
    })()
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
      if (this.stopped || this.activity.get(sessionID) !== token) return false
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

  private async executionFailed(data: any): Promise<void> {
    const sessionID = data?.sessionID
    if (
      typeof sessionID !== "string" ||
      !isLimitError(data?.error) ||
      this.stopped ||
      this.options.resumeAfterFailover === false ||
      this.failedExecutions.has(sessionID)
    ) {
      return
    }
    this.failedExecutions.add(sessionID)
    const token = this.activity.get(sessionID)
    try {
      let pending = this.pending.get(sessionID)
      if (!pending) {
        const session = await this.ctx.session.get({ sessionID })
        if (this.stopped || this.activity.get(sessionID) !== token) return
        pending = this.pending.get(sessionID)
        if (
          !pending &&
          session.model &&
          (await this.failover(sessionID, session.model, data.error))
        ) {
          pending = this.pending.get(sessionID)
        }
      }
      if (!pending || this.stopped) return
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
    return {
      enabled: this.options.enabled !== false,
      autoDiscover: this.options.autoDiscover !== false,
      strategy: strategy(this.options.strategy, "free-fastest"),
      modelsDiscovered: this.models.length,
      groups: [...this.groups.values()].map((group) => ({
        name: group.name,
        automatic: group.automatic,
        strategy: group.strategy,
        candidates: group.candidates.map((candidate) => {
          const key = modelKey(candidate)
          const current = this.metrics.get(key) ?? metric()
          const actualCost = actualCostPerMillion(current)
          return {
            model: key,
            free: isFree(candidate.info),
            available: (this.cooldowns.get(key) ?? 0) <= now,
            cooldownMs: Math.max(0, (this.cooldowns.get(key) ?? 0) - now),
            ...current,
            ...(actualCost === undefined ? {} : { actualCostPerMillionUSD: actualCost }),
          }
        }),
      })),
    }
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
          select: async (input: { sessionID: string; model: string }) => {
            const ref = parseRef(input.model)
            const candidate = ref
              ? [...this.groups.values()].flatMap((group) => group.candidates).find((item) => sameModel(item, ref))
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
    this.timer = setInterval(() => void this.refresh(), positiveNumber(this.options.rescanIntervalMs, 60_000))
    this.timer.unref?.()
  }

  cleanup(): void {
    if (this.stopped) return
    this.stopped = true
    this.lifecycle.abort()
    if (this.timer) clearInterval(this.timer)
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
