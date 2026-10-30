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

const status = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    autoDiscover: { type: "boolean" },
    strategy: { type: "string" },
    modelsDiscovered: { type: "number" },
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
  required: ["enabled", "autoDiscover", "strategy", "modelsDiscovered", "groups"],
  additionalProperties: false,
} as const

export const ModelAutoRouterRpc = Rpc.define({
  id: "opecode-model-autorouter",
  methods: {
    status: { input: empty, output: status },
    rescan: { input: empty, output: status },
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
