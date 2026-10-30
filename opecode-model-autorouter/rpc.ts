import { Rpc } from "@opencode/plugin/rpc"

const empty = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

const candidate = {
  type: "object",
  properties: {
    model: { type: "string" },
    free: { type: "boolean" },
    available: { type: "boolean" },
    cooldownMs: { type: "number" },
    successes: { type: "number" },
    failures: { type: "number" },
    latencyMs: { type: "number" },
    ttfbMs: { type: "number" },
    outputTokensPerSecond: { type: "number" },
    totalCostUSD: { type: "number" },
    generatedTokens: { type: "number" },
    actualCostPerMillionUSD: { type: "number" },
  },
  required: [
    "model",
    "free",
    "available",
    "cooldownMs",
    "successes",
    "failures",
    "totalCostUSD",
    "generatedTokens",
  ],
  additionalProperties: false,
} as const

const cost = {
  type: "array",
  items: {
    type: "object",
    properties: {
      tier: {
        type: "object",
        properties: {
          type: { type: "string" },
          size: { type: "number" },
        },
        required: ["type", "size"],
        additionalProperties: false,
      },
      input: { type: "number" },
      output: { type: "number" },
      cache: {
        type: "object",
        properties: {
          read: { type: "number" },
          write: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    required: ["input", "output"],
    additionalProperties: false,
  },
} as const

const model = {
  type: "object",
  properties: {
    ...candidate.properties,
    providerID: { type: "string" },
    id: { type: "string" },
    name: { type: "string" },
    enabled: { type: "boolean" },
    routingEnabled: { type: "boolean" },
    costCurrency: { type: "string" },
    priceState: { type: "string", enum: ["live", "stale"] },
    variants: { type: "array", items: { type: "string" } },
    cost,
    limit: {
      type: "object",
      properties: {
        context: { type: "number" },
        output: { type: "number" },
      },
      additionalProperties: false,
    },
    capabilities: {
      type: "object",
      properties: {
        tools: { type: "boolean" },
        input: { type: "array", items: { type: "string" } },
        output: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    groups: { type: "array", items: { type: "string" } },
  },
  required: [
    ...candidate.required,
    "providerID",
    "id",
    "enabled",
    "routingEnabled",
    "variants",
    "groups",
  ],
  additionalProperties: false,
} as const

const status = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    autoDiscover: { type: "boolean" },
    strategy: { type: "string" },
    defaultGroup: { type: "string" },
    resumeAfterFailover: { type: "boolean" },
    cooldownMs: { type: "number" },
    metricAlpha: { type: "number" },
    rescanIntervalMs: { type: "number" },
    accounts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          providerID: { type: "string" },
          state: { type: "string", enum: ["live", "stale", "unsupported"] },
          updatedAt: { type: "string" },
          pricingSupported: { type: "boolean" },
          balanceSupported: { type: "boolean" },
          matchedModels: { type: "number" },
          balance: { type: "number" },
          balanceCurrency: { type: "string" },
        },
        required: ["providerID", "state", "pricingSupported", "balanceSupported", "matchedModels"],
        additionalProperties: false,
      },
    },
    disabledModels: { type: "array", items: { type: "string" } },
    manualGroups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          strategy: { type: "string" },
          models: { type: "array", items: { type: "string" } },
        },
        required: ["name", "strategy", "models"],
        additionalProperties: false,
      },
    },
    modelsDiscovered: { type: "number" },
    models: { type: "array", items: model },
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          automatic: { type: "boolean" },
          strategy: { type: "string" },
          candidates: { type: "array", items: candidate },
        },
        required: ["name", "automatic", "strategy", "candidates"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "enabled",
    "autoDiscover",
    "strategy",
    "resumeAfterFailover",
    "cooldownMs",
    "metricAlpha",
    "rescanIntervalMs",
    "accounts",
    "disabledModels",
    "manualGroups",
    "modelsDiscovered",
    "models",
    "groups",
  ],
  additionalProperties: false,
} as const

const modelRef = {
  type: "object",
  properties: {
    providerID: { type: "string" },
    id: { type: "string" },
    variant: { type: "string" },
  },
  required: ["providerID", "id"],
  additionalProperties: false,
} as const

const configure = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    autoDiscover: { type: "boolean" },
    strategy: { type: "string" },
    defaultGroup: { type: "string" },
    resumeAfterFailover: { type: "boolean" },
    disabledModels: { type: "array", items: { type: "string" } },
    groups: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          models: {
            type: "array",
            items: {
              anyOf: [{ type: "string" }, modelRef],
            },
          },
          strategy: { type: "string" },
        },
        required: ["models"],
        additionalProperties: false,
      },
    },
    cooldownMs: { type: "number" },
    metricAlpha: { type: "number" },
    rescanIntervalMs: { type: "number" },
    reset: { type: "boolean" },
  },
  additionalProperties: false,
} as const

export const ModelAutoRouterRpc = Rpc.define({
  id: "opecode-model-autorouter",
  methods: {
    status: { input: empty, output: status },
    rescan: { input: empty, output: status },
    configure: { input: configure, output: status },
    select: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          model: { type: "string" },
        },
        required: ["sessionID", "model"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { selected: { type: "string" } },
        required: ["selected"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
