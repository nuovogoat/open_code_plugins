import assert from "node:assert/strict"
import test from "node:test"
import {
  normalizeRouterOptions,
  setupModelAutoRouter,
  type ModelInfo,
  type PluginContext,
} from "../core.ts"

const gc = (globalThis as { gc?: () => void }).gc

function model(providerID: string, id = "same", cost = 0): ModelInfo {
  return {
    providerID,
    id,
    type: "chat",
    enabled: true,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 200_000, output: 8_000 },
    cost: [{ input: cost, output: cost, cache: { read: 0, write: 0 } }],
  }
}

function harness(models: ModelInfo[], options: Record<string, unknown> = {}) {
  const rpcHandlers: Record<string, (input: any) => Promise<unknown>> = {}
  const registration = async () => ({ dispose() {} })
  const ctx: PluginContext = {
    options,
    model: {
      async list() {
        return { data: models }
      },
    },
    pricing: {
      async load() {
        return []
      },
    },
    session: {
      async get() {
        return {}
      },
      async switchModel() {},
      async synthetic() {
        return {}
      },
      hook: registration as never,
    },
    event: {
      subscribe({ signal }) {
        return (async function* () {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener("abort", () => resolve(), { once: true })
          })
        })()
      },
    },
    rpc: {
      async register(_definition, handlers) {
        Object.assign(rpcHandlers, handlers)
        return { dispose() {} }
      },
    },
  }
  return { ctx, rpcHandlers }
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() >= deadline) assert.fail("condition was not reached")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const listingBody = JSON.stringify({
  data: [{ id: "same", pricing: { prompt: "0.000001", completion: "0.000002" } }],
})

function listingFetch(requests: string[] = []): typeof fetch {
  return (async (url: unknown) => {
    requests.push(String(url))
    return new Response(listingBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

test("robustness: garbage providerSites are normalized away, prototypes stay clean", () => {
  const garbage: unknown[] = [
    { providerSites: 42 },
    { providerSites: "https://x.example" },
    { providerSites: null },
    { providerSites: [] },
    { providerSites: { a: 42, b: null, c: {}, d: [], e: "", f: ["https://x.example"] } },
    { providerSites: { a: "javascript:alert(1)", b: "data:text/html,x", c: "file:///C:/x" } },
    { providerSites: { a: "http://evil.example", b: "https://user:pass@x.example" } },
    { providerSites: { ["__proto__"]: "https://evil.example" } },
    { accountThresholds: { ["__proto__"]: { minBalance: 1 } } },
    { priceLimits: { ["__proto__"]: { inputMax: 1 } } },
    { groups: { ["__proto__"]: { models: ["a/same"] } } },
  ]
  for (const value of garbage) {
    const result = normalizeRouterOptions(value)
    for (const site of Object.values(result.providerSites ?? {})) {
      assert.equal(typeof site, "string")
      assert.ok(site.startsWith("https://") || site.startsWith("http://localhost"))
    }
    // "__proto__" never becomes an own key of a normalized record.
    for (const record of [result.providerSites, result.accountThresholds, result.priceLimits, result.groups]) {
      if (record) assert.equal(Object.prototype.hasOwnProperty.call(record, "__proto__"), false)
    }
  }
  const canary: Record<string, unknown> = {}
  assert.equal(canary.minBalance, undefined)
  assert.equal(canary.inputMax, undefined)
  assert.equal(canary.models, undefined)
})

test("robustness: absurd configure patches are normalized, not fatal", async () => {
  const { ctx, rpcHandlers } = harness([model("a")])
  // Hermetic: discovery must never reach the real network from unit tests.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error("offline")
  }) as typeof fetch
  const cleanup = setupModelAutoRouter(ctx, {})
  try {
    await eventually(() => rpcHandlers.configure !== undefined)
    const patches: unknown[] = [
      { providerSites: 42 },
      { providerSites: "https://x.example" },
      { providerSites: [] },
      { providerSites: { a: 42, b: ["x"], c: { url: "y" } } },
      { providerSites: { ["__proto__"]: "https://evil.example" } },
      {
        providerSites: Object.fromEntries(
          Array.from({ length: 200 }, (_, index) => [`p${index}`, `https://p${index}.example`]),
        ),
      },
      { strategy: 42, cooldownMs: -5, rescanIntervalMs: 0, disabledModels: 7, metricAlpha: "x" },
      { accountThresholds: "no", priceLimits: 13, cbrOrientation: "yes" },
    ]
    for (const patch of patches) {
      const status = (await rpcHandlers.configure(patch as never)) as any
      assert.ok(Array.isArray(status.models))
      assert.ok(Array.isArray(status.groups))
    }
    const status = (await rpcHandlers.status({})) as any
    // The 200-entry patch is capped at 50 normalized sites.
    assert.equal(Object.keys(status.providerSites).length, 50)
    const canary: Record<string, unknown> = {}
    assert.equal(canary.minBalance, undefined)
  } finally {
    globalThis.fetch = originalFetch
    cleanup()
  }
})

test("robustness: hostile fetch behavior never crashes a refresh and invents no prices", async () => {
  const { ctx, rpcHandlers } = harness([model("pub", "same")])
  const originalFetch = globalThis.fetch
  const behaviors: Array<typeof fetch> = [
    (() => {
      throw new Error("sync boom")
    }) as unknown as typeof fetch,
    (async () => {
      throw new Error("async boom")
    }) as typeof fetch,
    (async () =>
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch,
    (async () => new Response(JSON.stringify({ data: "garbage" }), { status: 200 })) as typeof fetch,
    (async () => new Response("[]", { status: 500 })) as typeof fetch,
    (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "10" }),
      json: async () => {
        throw new Error("json boom")
      },
    })) as unknown as typeof fetch,
    (async () =>
      new Response(listingBody, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "999999999" },
      })) as typeof fetch,
  ]
  const cleanup = setupModelAutoRouter(ctx, {})
  try {
    await eventually(() => rpcHandlers.configure !== undefined)
    for (const [index, behavior] of behaviors.entries()) {
      globalThis.fetch = behavior
      const status = (await rpcHandlers.configure({
        providerSites: { [`pub${index}`]: "https://pub.example" },
      })) as any
      assert.ok(Array.isArray(status.models))
      // No behavior may produce a recognized public listing.
      assert.deepEqual(status.publicPricing, [])
      const pub = status.models.find((item: any) => item.model === "pub/same")
      assert.equal(pub.priceState, undefined)
      assert.equal(pub.cost, undefined)
    }
  } finally {
    globalThis.fetch = originalFetch
    cleanup()
    cleanup()
  }
})

test("robustness: cleanup during in-flight discovery aborts requests without unhandled rejections", async () => {
  const { ctx, rpcHandlers } = harness([model("pub", "same")], {
    providerSites: { pub: "https://pub.example" },
  })
  const originalFetch = globalThis.fetch
  let aborted = 0
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted++
        reject(new DOMException("This operation was aborted", "AbortError"))
      })
    })) as unknown as typeof fetch
  const cleanup = setupModelAutoRouter(ctx, {})
  await eventually(() => rpcHandlers.rescan !== undefined)
  const pending = rpcHandlers.rescan({}).then(
    () => undefined,
    () => undefined,
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  cleanup()
  await pending
  assert.ok(aborted >= 1, "in-flight discovery must be aborted by cleanup")
  globalThis.fetch = originalFetch
})

test("robustness: repeated site churn keeps public snapshots bounded", async () => {
  const { ctx, rpcHandlers } = harness([model("pub", "same")])
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = listingFetch(requests)
  const cleanup = setupModelAutoRouter(ctx, {})
  try {
    await eventually(() => rpcHandlers.configure !== undefined)
    for (let index = 0; index < 200; index++) {
      const status = (await rpcHandlers.configure({
        providerSites: { [`p${index}`]: "https://p.example" },
      })) as any
      // Snapshots of removed providers are dropped: the map never grows past the current site.
      assert.ok(
        status.publicPricing.length <= 1,
        `public snapshots grew to ${status.publicPricing.length}`,
      )
    }
  } finally {
    globalThis.fetch = originalFetch
    cleanup()
  }
})

test("robustness: 500 setup/discovery/cleanup cycles do not grow the heap unboundedly", { timeout: 120_000, skip: !gc }, async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = listingFetch()
  const restoreError = console.error
  console.error = () => {}
  try {
    const cycle = async () => {
      const { ctx, rpcHandlers } = harness([model("pub", "same")], {
        providerSites: { pub: "https://pub.example" },
      })
      const cleanup = setupModelAutoRouter(ctx, {})
      await eventually(() => rpcHandlers.rescan !== undefined)
      await rpcHandlers.rescan({}).catch(() => undefined)
      cleanup()
    }
    for (let index = 0; index < 50; index++) await cycle()
    await new Promise((resolve) => setImmediate(resolve))
    gc!()
    gc!()
    const baseline = process.memoryUsage().heapUsed
    for (let index = 0; index < 500; index++) {
      await cycle()
      if (index % 50 === 0) await new Promise((resolve) => setImmediate(resolve))
    }
    await new Promise((resolve) => setImmediate(resolve))
    gc!()
    gc!()
    const retained = process.memoryUsage().heapUsed - baseline
    assert.ok(
      retained < 16 * 1024 * 1024,
      `retained heap grew by ${retained} bytes after 500 discovery cycles`,
    )
    console.log(JSON.stringify({ cycles: 500, retainedHeapBytes: retained }))
  } finally {
    console.error = restoreError
    globalThis.fetch = originalFetch
  }
})
