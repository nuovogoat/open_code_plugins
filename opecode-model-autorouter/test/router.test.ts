import assert from "node:assert/strict"
import test from "node:test"
import {
  buildRouteGroups,
  isLimitError,
  modelKey,
  parseRetryAfter,
  selectCandidate,
  setupModelAutoRouter,
  type ModelInfo,
  type ModelMetrics,
  type ModelRef,
  type PluginContext,
  type RouterEvent,
} from "../core.ts"

function model(providerID: string, id = "same", cost = 0, context = 200_000): ModelInfo {
  return {
    providerID,
    id,
    type: "chat",
    enabled: true,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context, output: 8_000 },
    cost: [{ input: cost, output: cost, cache: { read: 0, write: 0 } }],
  }
}

function metrics(values: Partial<ModelMetrics>): ModelMetrics {
  return { successes: 1, failures: 0, totalCostUSD: 0, generatedTokens: 0, ...values }
}

test("discovery: only exact enabled chat model IDs from distinct providers form automatic groups", () => {
  const paid = model("paid", "same", 2)
  const textOnly = model("text", "same")
  textOnly.type = "decision"
  const disabled = model("disabled", "same")
  disabled.enabled = false
  const groups = buildRouteGroups([
    model("free-a"),
    model("free-b"),
    paid,
    textOnly,
    disabled,
    model("free-a", "different"),
  ])
  assert.deepEqual([...groups.keys()], ["auto:same"])
  assert.deepEqual(
    groups.get("auto:same")!.candidates.map((candidate) => candidate.providerID),
    ["free-a", "free-b", "paid"],
  )
})

test("discovery: manual groups explicitly connect different model IDs and override automatic names", () => {
  const groups = buildRouteGroups([model("a", "one"), model("b", "two")], {
    groups: {
      chosen: { models: ["a/one", { providerID: "b", id: "two", variant: "max" }] },
    },
  })
  assert.deepEqual([...groups.keys()], ["chosen"])
  assert.equal(groups.get("chosen")!.automatic, false)
  assert.equal(groups.get("chosen")!.candidates[1].variant, "max")
})

test("routing: free-fastest explores unknown alternatives then uses measured generation speed", () => {
  const group = buildRouteGroups([
    model("paid", "same", 5),
    model("slow"),
    model("fast"),
  ]).get("auto:same")!
  const stats = new Map<string, ModelMetrics>([
    ["paid/same", metrics({ outputTokensPerSecond: 1000 })],
    ["slow/same", metrics({ outputTokensPerSecond: 10 })],
    ["fast/same", metrics({ outputTokensPerSecond: 100 })],
  ])
  assert.equal(selectCandidate(group, undefined, stats, new Map(), 0)!.providerID, "fast")
  stats.delete("fast/same")
  assert.equal(selectCandidate(group, undefined, stats, new Map(), 0)!.providerID, "fast")
})

test("routing: automatic groups recognize the current model independently of its variant", () => {
  const group = buildRouteGroups([model("a"), model("b")]).get("auto:same")!
  const current = { providerID: "a", id: "same", variant: "max" }
  assert.equal(
    selectCandidate(group, current, new Map(), new Map(), 0, new Set(), false)!.providerID,
    "b",
  )
})

test("routing: unknown pricing is not treated as free", () => {
  const unknown = model("unknown")
  delete unknown.cost
  const group = buildRouteGroups([unknown, model("free"), model("paid", "same", 1)]).get(
    "auto:same",
  )!
  assert.equal(selectCandidate(group, undefined, new Map(), new Map(), 0)!.providerID, "free")
})

test("routing: cheapest prefers measured cost and manual preserves configured priority", () => {
  const models = [model("a", "one", 1), model("b", "two", 2)]
  const groups = buildRouteGroups(models, {
    strategy: "cheapest",
    groups: { chosen: { models: ["b/two", "a/one"] } },
  })
  const group = groups.get("chosen")!
  const stats = new Map<string, ModelMetrics>([
    ["a/one", metrics({ generatedTokens: 1000, totalCostUSD: 0.01 })],
    ["b/two", metrics({ generatedTokens: 1000, totalCostUSD: 0.001 })],
  ])
  assert.equal(selectCandidate(group, undefined, stats, new Map(), 0)!.providerID, "b")
  group.strategy = "manual"
  assert.equal(selectCandidate(group, undefined, stats, new Map(), 0)!.providerID, "b")
})

test("routing: cooldown, tools and automatic context compatibility are enforced", () => {
  const small = model("small", "same", 0, 100_000)
  const noTools = model("no-tools")
  noTools.capabilities = { tools: false }
  const group = buildRouteGroups([model("large"), small, noTools]).get("auto:same")!
  const current: ModelRef = { providerID: "large", id: "same" }
  assert.equal(selectCandidate(group, current, new Map(), new Map(), 0, new Set(), false), undefined)

  const manual = buildRouteGroups([model("large"), small], {
    groups: { chosen: { models: ["large/same", "small/same"] } },
  }).get("chosen")!
  assert.equal(
    selectCandidate(manual, current, new Map(), new Map([["small/same", 1000]]), 0, new Set(), false),
    undefined,
  )
  assert.equal(
    selectCandidate(manual, current, new Map(), new Map([["small/same", 1000]]), 1000, new Set(), false)!
      .providerID,
    "small",
  )
})

test("errors: retry headers use the unit from the header name", () => {
  assert.equal(parseRetryAfter({ get: (name: string) => name === "retry-after-ms" ? "5000" : null }), 5000)
  assert.equal(parseRetryAfter({ get: (name: string) => name === "retry-after" ? "0.5" : null }), 500)
})

test("errors: quota signals are recognized without retaining provider response text", () => {
  assert.equal(isLimitError({ status: 429 }), true)
  assert.equal(isLimitError({ status: 402 }), true)
  assert.equal(isLimitError({ type: "provider.rate-limit" }), true)
  assert.equal(isLimitError({ message: "insufficient balance" }), true)
  assert.equal(isLimitError({ status: 500, message: "internal" }), false)
})

interface FakeContext extends PluginContext {
  hooks: Map<string, (event: any) => void | Promise<void>>
  emit(event: RouterEvent): void
  switches: Array<{ sessionID: string; model: ModelRef }>
  synthetics: any[]
  rpcHandlers: Record<string, (input: any) => Promise<unknown>>
  current: ModelRef
  disposed(): number
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail("condition was not reached")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function fakeContext(models: ModelInfo[], options: Record<string, unknown> = {}): FakeContext {
  const hooks = new Map<string, (event: any) => void | Promise<void>>()
  const queue: RouterEvent[] = []
  const switches: Array<{ sessionID: string; model: ModelRef }> = []
  const synthetics: any[] = []
  const rpcHandlers: Record<string, (input: any) => Promise<unknown>> = {}
  const current: ModelRef = { providerID: models[0].providerID, id: models[0].id }
  let wake: (() => void) | undefined
  let disposed = 0
  let controller: AbortController | undefined

  const ctx: FakeContext = {
    options: options,
    hooks,
    emit(event) {
      queue.push(event)
      wake?.()
    },
    switches,
    synthetics,
    rpcHandlers,
    current,
    disposed: () => disposed,
    model: {
      async list() {
        return { data: models }
      },
    },
    session: {
      async get() {
        return { model: current }
      },
      async switchModel(input) {
        switches.push(input)
        current.providerID = input.model.providerID
        current.id = input.model.id
        current.variant = input.model.variant
      },
      async synthetic(input) {
        synthetics.push(input)
        return {}
      },
      async hook(name, callback) {
        hooks.set(name, callback)
        return { dispose: () => disposed++ }
      },
    },
    event: {
      subscribe({ signal }) {
        controller = undefined
        const local = new AbortController()
        controller = local
        const abort = () => {
          local.abort()
          wake?.()
        }
        if (signal.aborted) abort()
        else signal.addEventListener("abort", abort, { once: true })
        return (async function* () {
          try {
            while (!local.signal.aborted) {
              if (queue.length === 0) {
                await new Promise<void>((resolve) => {
                  wake = resolve
                  if (local.signal.aborted) resolve()
                })
              }
              while (queue.length > 0) yield queue.shift()!
            }
          } finally {
            signal.removeEventListener("abort", abort)
          }
        })()
      },
    },
    rpc: {
      async register(_definition, handlers) {
        Object.assign(rpcHandlers, handlers)
        return { dispose: () => disposed++ }
      },
    },
  }
  void controller
  return ctx
}

test("live routing: prompt admission selects the fastest free model from real step metrics", async () => {
  const ctx = fakeContext([model("paid", "same", 4), model("slow"), model("fast")])
  const cleanup = setupModelAutoRouter(ctx, {})
  try {
    await eventually(() => ctx.hooks.has("prompt") && ctx.rpcHandlers.rescan !== undefined)
    await ctx.rpcHandlers.rescan({})
    await ctx.hooks.get("prompt")!({ sessionID: "ses" })
    assert.equal(ctx.switches.at(-1)?.model.providerID, "slow")

    const slowModel = { providerID: "slow", id: "same" }
    await ctx.hooks.get("model.request")!({ sessionID: "ses", kind: "primary", model: slowModel })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await ctx.hooks.get("http.response")!({
      sessionID: "ses",
      kind: "primary",
      model: slowModel,
      response: { status: 200, headers: { get: () => undefined } },
    })

    ctx.emit({
      type: "session.step.started",
      data: { sessionID: "ses", assistantMessageID: "a", model: { providerID: "slow", id: "same" } },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    ctx.emit({
      type: "session.step.ended",
      data: {
        sessionID: "ses",
        assistantMessageID: "a",
        cost: 0,
        tokens: { output: 100, reasoning: 0 },
      },
    })
    ctx.emit({
      type: "session.step.started",
      data: { sessionID: "ses", assistantMessageID: "b", model: { providerID: "fast", id: "same" } },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    ctx.emit({
      type: "session.step.ended",
      data: {
        sessionID: "ses",
        assistantMessageID: "b",
        cost: 0,
        tokens: { output: 1000, reasoning: 0 },
      },
    })
    await eventually(async () => {
      const status = (await ctx.rpcHandlers.status({})) as any
      const fast = status.groups[0]?.candidates.find(
        (candidate: any) => candidate.model === "fast/same",
      )
      return fast?.outputTokensPerSecond > 0
    })
    await ctx.hooks.get("prompt")!({ sessionID: "ses" })
    assert.equal(ctx.switches.at(-1)?.model.providerID, "fast")

    const status = (await ctx.rpcHandlers.status({})) as any
    const fast = status.groups[0].candidates.find((candidate: any) => candidate.model === "fast/same")
    assert.ok(fast.outputTokensPerSecond > 0)
    assert.equal(fast.free, true)
    const slowStatus = status.groups[0].candidates.find(
      (candidate: any) => candidate.model === "slow/same",
    )
    assert.ok(slowStatus.ttfbMs > 0)
    assert.equal(JSON.stringify(status).includes("assistantMessageID"), false)
  } finally {
    cleanup()
  }
})

test("failover: a provider limit switches model and resumes once without duplicating the prompt", async () => {
  const ctx = fakeContext([model("a"), model("b")])
  const cleanup = setupModelAutoRouter(ctx, {})
  try {
    await eventually(() => ctx.hooks.has("retry") && ctx.rpcHandlers.rescan !== undefined)
    await ctx.rpcHandlers.rescan({})
    const event = {
      sessionID: "ses",
      model: { providerID: "a", id: "same" },
      error: { status: 429, retryAfterMs: 5000 },
      decision: { retry: true, delay: 1000 },
    }
    await ctx.hooks.get("retry")!(event)
    assert.deepEqual(event.decision, { retry: false })
    assert.equal(ctx.switches.at(-1)?.model.providerID, "b")
    assert.equal(ctx.synthetics.length, 0)

    ctx.emit({ type: "session.execution.failed", data: { sessionID: "ses", error: { status: 429 } } })
    await eventually(() => ctx.synthetics.length === 1)
    assert.equal(ctx.synthetics[0].resume, true)
    assert.match(ctx.synthetics[0].text, /Continue the existing task/u)
    ctx.emit({ type: "session.execution.failed", data: { sessionID: "ses", error: { status: 429 } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(ctx.synthetics.length, 1)

    const status = (await ctx.rpcHandlers.status({})) as any
    const a = status.groups[0].candidates.find((candidate: any) => candidate.model === "a/same")
    assert.equal(a.available, false)
    assert.ok(a.cooldownMs > 0)
  } finally {
    cleanup()
  }
})

test("failover: alternatives are tried at most once and user activity cancels automatic continuation", async () => {
  const ctx = fakeContext([model("a"), model("b"), model("c")])
  const cleanup = setupModelAutoRouter(ctx)
  try {
    await eventually(() => ctx.hooks.has("retry") && ctx.hooks.has("prompt"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const failure = (providerID: string) => ({
      sessionID: "ses",
      model: { providerID, id: "same" },
      error: { status: 429 },
      decision: { retry: true, delay: 0 },
    })
    const first = failure("a")
    await ctx.hooks.get("retry")!(first)
    assert.equal(ctx.switches.at(-1)?.model.providerID, "b")
    const second = failure("b")
    await ctx.hooks.get("retry")!(second)
    assert.equal(ctx.switches.at(-1)?.model.providerID, "c")
    const third = failure("c")
    await ctx.hooks.get("retry")!(third)
    assert.deepEqual(third.decision, { retry: true, delay: 0 })
    assert.equal(ctx.switches.length, 2)

    await ctx.hooks.get("prompt")!({ sessionID: "ses" })
    ctx.emit({ type: "session.execution.failed", data: { sessionID: "ses", error: { status: 429 } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(ctx.synthetics.length, 0)
  } finally {
    cleanup()
  }
})

test("failover: a terminal execution limit switches and resumes even without a retry hook", async () => {
  const ctx = fakeContext([model("a"), model("b")])
  const cleanup = setupModelAutoRouter(ctx, {})
  try {
    await eventually(() => ctx.rpcHandlers.rescan !== undefined)
    await ctx.rpcHandlers.rescan({})
    ctx.emit({
      type: "session.execution.failed",
      data: { sessionID: "ses", error: { status: 402 } },
    })
    await eventually(() => ctx.synthetics.length === 1)
    assert.equal(ctx.switches.length, 1)
    assert.equal(ctx.switches[0].model.providerID, "b")
  } finally {
    cleanup()
  }
})

test("failover: auxiliary model failures cannot switch the primary session model", async () => {
  const ctx = fakeContext([model("a"), model("b")])
  const cleanup = setupModelAutoRouter(ctx, {})
  try {
    await eventually(() => ctx.hooks.has("http.response") && ctx.rpcHandlers.rescan !== undefined)
    await ctx.rpcHandlers.rescan({})
    await ctx.hooks.get("http.response")!({
      sessionID: "ses",
      kind: "title",
      model: { providerID: "a", id: "same" },
      response: { status: 429, headers: { get: () => undefined } },
    })
    assert.equal(ctx.switches.length, 0)
  } finally {
    cleanup()
  }
})

test("failover: HTTP limit and retry for the same request select only one alternative", async () => {
  const ctx = fakeContext([model("a"), model("b"), model("c")])
  const cleanup = setupModelAutoRouter(ctx, {})
  try {
    await eventually(() => ctx.hooks.has("http.response") && ctx.rpcHandlers.rescan !== undefined)
    await ctx.rpcHandlers.rescan({})
    const current = { providerID: "a", id: "same" }
    await ctx.hooks.get("http.response")!({
      sessionID: "ses",
      kind: "primary",
      model: current,
      response: { status: 429, headers: { get: () => undefined } },
    })
    const retry = {
      sessionID: "ses",
      model: current,
      error: { status: 429 },
      decision: { retry: true, delay: 0 },
    }
    await ctx.hooks.get("retry")!(retry)
    assert.equal(ctx.switches.length, 1)
    assert.equal(ctx.switches[0].model.providerID, "b")
    assert.deepEqual(retry.decision, { retry: false })

    ctx.emit({ type: "session.execution.failed", data: { sessionID: "ses", error: { status: 429 } } })
    await eventually(() => ctx.synthetics.length === 1)
  } finally {
    cleanup()
  }
})

test("failover: synthetic activity is routed without cancelling the failover attempts", async () => {
  const ctx = fakeContext([model("a"), model("b"), model("c")])
  const cleanup = setupModelAutoRouter(ctx, {})
  try {
    await eventually(() => ctx.hooks.has("prompt") && ctx.rpcHandlers.rescan !== undefined)
    await ctx.rpcHandlers.rescan({})
    await ctx.hooks.get("retry")!({
      sessionID: "ses",
      model: { providerID: "a", id: "same" },
      error: { status: 429 },
      decision: { retry: true, delay: 0 },
    })
    ctx.emit({ type: "session.execution.failed", data: { sessionID: "ses", error: { status: 429 } } })
    await eventually(() => ctx.synthetics.length === 1)
    const switchesBefore = ctx.switches.length
    await ctx.hooks.get("prompt")!({
      sessionID: "ses",
      metadata: { source: "opecode-model-autorouter" },
    })
    assert.equal(ctx.switches.length, switchesBefore)
    await ctx.hooks.get("retry")!({
      sessionID: "ses",
      model: { providerID: "b", id: "same" },
      error: { status: 429 },
      decision: { retry: true, delay: 0 },
    })
    assert.equal(ctx.switches.at(-1)?.model.providerID, "c")
  } finally {
    cleanup()
  }
})

test("failover: disabled automatic resume still switches without changing native retry", async () => {
  const ctx = fakeContext([model("a"), model("b")], { resumeAfterFailover: false })
  const cleanup = setupModelAutoRouter(ctx, {})
  try {
    await eventually(() => ctx.hooks.has("retry") && ctx.rpcHandlers.rescan !== undefined)
    await ctx.rpcHandlers.rescan({})
    const event = {
      sessionID: "ses",
      model: { providerID: "a", id: "same" },
      error: { status: 429 },
      decision: { retry: true, delay: 100 },
    }
    await ctx.hooks.get("retry")!(event)
    assert.equal(ctx.switches.at(-1)?.model.providerID, "b")
    assert.deepEqual(event.decision, { retry: true, delay: 100 })
    ctx.emit({ type: "session.execution.failed", data: { sessionID: "ses", error: { status: 429 } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(ctx.synthetics.length, 0)
  } finally {
    cleanup()
  }
})

test("failover: user activity during an in-flight switch invalidates stale continuation", async () => {
  const ctx = fakeContext([model("a"), model("b")])
  const cleanup = setupModelAutoRouter(ctx, {})
  const originalSwitch = ctx.session.switchModel.bind(ctx.session)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  ctx.session.switchModel = async (input) => {
    calls++
    if (calls === 1) await gate
    await originalSwitch(input)
  }
  try {
    await eventually(() => ctx.hooks.has("prompt") && ctx.rpcHandlers.rescan !== undefined)
    await ctx.rpcHandlers.rescan({})
    const retry = ctx.hooks.get("retry")!({
      sessionID: "ses",
      model: { providerID: "a", id: "same" },
      error: { status: 429 },
      decision: { retry: true, delay: 0 },
    })
    await eventually(() => calls === 1)
    await ctx.hooks.get("prompt")!({ sessionID: "ses" })
    release()
    await retry
    ctx.emit({ type: "session.execution.failed", data: { sessionID: "ses", error: { status: 429 } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(ctx.synthetics.length, 0)
  } finally {
    release()
    cleanup()
  }
})

test("manual default group routes an unrelated current model and RPC select is explicit", async () => {
  const ctx = fakeContext([model("other", "other"), model("a", "one"), model("b", "two")], {
    defaultGroup: "chosen",
    groups: {
      chosen: {
        models: ["a/one", { providerID: "b", id: "two", variant: "max" }],
        strategy: "manual",
      },
    },
  })
  const cleanup = setupModelAutoRouter(ctx, {})
  try {
    await eventually(() => ctx.hooks.has("prompt") && ctx.rpcHandlers.rescan !== undefined)
    await ctx.rpcHandlers.rescan({})
    await ctx.hooks.get("prompt")!({ sessionID: "ses" })
    assert.equal(ctx.switches.at(-1)?.model.providerID, "a")
    const result = await ctx.rpcHandlers.select({ sessionID: "ses", model: "b/two#max" })
    assert.deepEqual(result, { selected: "b/two#max" })
    assert.equal(modelKey(ctx.current), "b/two#max")
  } finally {
    cleanup()
  }
})

test("cleanup: registrations and event state are disposed, late continuation is impossible", async () => {
  const ctx = fakeContext([model("a"), model("b")])
  const cleanup = setupModelAutoRouter(ctx, {})
  await eventually(() => ctx.hooks.has("retry"))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await ctx.hooks.get("retry")!({
    sessionID: "ses",
    model: { providerID: "a", id: "same" },
    error: { status: 429 },
    decision: { retry: false },
  })
  cleanup()
  cleanup()
  assert.equal(ctx.disposed(), 5)
  ctx.emit({ type: "session.execution.failed", data: { sessionID: "ses", error: { status: 429 } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(ctx.synthetics.length, 0)
})
