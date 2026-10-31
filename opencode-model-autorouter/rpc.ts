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
    priceLimitBreached: { type: "boolean" },
    thresholdExcluded: { type: "boolean" },
    costCurrency: { type: "string" },
    priceState: { type: "string", enum: ["live", "stale", "public", "public-stale"] },
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

const accountThresholds = {
  type: "object",
  additionalProperties: {
    type: "object",
    properties: {
      minBalance: { type: "number", minimum: 0 },
      action: { type: "string", enum: ["warn", "exclude"] },
    },
    additionalProperties: false,
  },
} as const

/** Global per-currency price bounds; keyed by the account price currency. */
const priceLimits = {
  type: "object",
  additionalProperties: {
    type: "object",
    properties: {
      inputMin: { type: "number", minimum: 0 },
      inputMax: { type: "number", minimum: 0 },
      outputMin: { type: "number", minimum: 0 },
      outputMax: { type: "number", minimum: 0 },
      action: { type: "string", enum: ["warn", "exclude"] },
    },
    additionalProperties: false,
  },
} as const

/** One financial cost bucket of a session or of the totals row. */
const usageCost = {
  type: "object",
  properties: {
    amount: { type: "number" },
    currency: { type: "string" },
    basis: { type: "string", enum: ["account", "measured"] },
  },
  required: ["amount", "currency", "basis"],
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
    askBeforeOverride: { type: "boolean" },
    cooldownMs: { type: "number" },
    metricAlpha: { type: "number" },
    rescanIntervalMs: { type: "number" },
    accountThresholds,
    priceLimits,
    cbrOrientation: { type: "boolean" },
    providerSites: { type: "object", additionalProperties: { type: "string" } },
    publicPricing: {
      type: "array",
      items: {
        type: "object",
        properties: {
          providerID: { type: "string" },
          origin: { type: "string" },
          state: { type: "string", enum: ["live", "stale"] },
          fetchedAt: { type: "string" },
          stale: { type: "boolean" },
          matchedModels: { type: "number" },
        },
        required: ["providerID", "origin", "state", "fetchedAt", "stale", "matchedModels"],
        additionalProperties: false,
      },
    },
    cbr: {
      type: "object",
      properties: {
        date: { type: "string" },
        fetchedAt: { type: "string" },
        stale: { type: "boolean" },
        rates: { type: "object", additionalProperties: { type: "number" } },
      },
      required: ["date", "fetchedAt", "stale", "rates"],
      additionalProperties: false,
    },
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
          lowBalance: { type: "boolean" },
          keySource: { type: "string", enum: ["plugin", "opencode"] },
          pluginKey: { type: "boolean" },
        },
        required: ["providerID", "state", "pricingSupported", "balanceSupported", "matchedModels"],
        additionalProperties: false,
      },
    },
    disabledModels: { type: "array", items: { type: "string" } },
    overrideRequests: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          current: { type: "string" },
          proposed: { type: "string" },
          group: { type: "string" },
          askedAt: { type: "string" },
        },
        required: ["sessionID", "current", "proposed", "group", "askedAt"],
        additionalProperties: false,
      },
    },
    pinnedModels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          model: { type: "string" },
        },
        required: ["sessionID", "model"],
        additionalProperties: false,
      },
    },
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
    usage: {
      type: "object",
      properties: {
        sessions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sessionID: { type: "string" },
              model: { type: "string" },
              steps: { type: "number" },
              tokens: {
                type: "object",
                properties: {
                  input: { type: "number" },
                  output: { type: "number" },
                  reasoning: { type: "number" },
                  cacheRead: { type: "number" },
                  cacheWrite: { type: "number" },
                },
                required: ["input", "output", "reasoning", "cacheRead", "cacheWrite"],
                additionalProperties: false,
              },
              costs: { type: "array", items: usageCost },
              updatedAt: { type: "string" },
            },
            required: ["sessionID", "steps", "tokens", "costs", "updatedAt"],
            additionalProperties: false,
          },
        },
        totals: { type: "array", items: usageCost },
      },
      required: ["sessions", "totals"],
      additionalProperties: false,
    },
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
    "askBeforeOverride",
    "cooldownMs",
    "metricAlpha",
    "rescanIntervalMs",
    "accountThresholds",
    "priceLimits",
    "cbrOrientation",
    "providerSites",
    "publicPricing",
    "accounts",
    "disabledModels",
    "overrideRequests",
    "pinnedModels",
    "manualGroups",
    "modelsDiscovered",
    "usage",
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
    askBeforeOverride: { type: "boolean" },
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
    accountThresholds,
    priceLimits,
    cbrOrientation: { type: "boolean" },
    providerSites: { type: "object", additionalProperties: { type: "string" } },
    reset: { type: "boolean" },
  },
  additionalProperties: false,
} as const

export const ModelAutoRouterRpc = Rpc.define({
  id: "opencode-model-autorouter",
  methods: {
    status: { input: empty, output: status },
    rescan: { input: empty, output: status },
    configure: { input: configure, output: status },
    setAccountKey: {
      input: {
        type: "object",
        properties: {
          // Dynamic: any provider currently visible to the router. Validation
          // happens in core.ts against the live model/credentials roster;
          // the schema only enforces shape here.
          providerID: { type: "string", minLength: 1, maxLength: 128 },
          key: { type: "string", minLength: 1, maxLength: 512 },
        },
        required: ["providerID", "key"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          stored: { type: "boolean" },
          providerID: { type: "string" },
        },
        required: ["stored", "providerID"],
        additionalProperties: false,
      },
    },
    clearAccountKey: {
      input: {
        type: "object",
        properties: { providerID: { type: "string" } },
        required: ["providerID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { cleared: { type: "boolean" } },
        required: ["cleared"],
        additionalProperties: false,
      },
    },
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
    resolveOverrideRequest: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", minLength: 1 },
          action: { type: "string", enum: ["keep", "override"] },
        },
        required: ["sessionID", "action"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          resolved: { type: "string", enum: ["keep", "override"] },
          model: { type: "string" },
          pinned: { type: "boolean" },
        },
        required: ["resolved", "model", "pinned"],
        additionalProperties: false,
      },
    },
    releaseManualSelection: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { released: { type: "boolean" } },
        required: ["released"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
