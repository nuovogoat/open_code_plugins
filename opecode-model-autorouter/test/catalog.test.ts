import assert from "node:assert/strict"
import test from "node:test"
import {
  catalogPrice,
  formatBalance,
  formatLatency,
  formatPrice,
  formatSpeed,
  organizeModels,
  type CatalogModel,
} from "../src/catalog.ts"

function model(
  providerID: string,
  id: string,
  values: Partial<CatalogModel> = {},
): CatalogModel {
  return {
    model: `${providerID}/${id}`,
    providerID,
    id,
    name: values.name ?? id,
    enabled: true,
    routingEnabled: true,
    free: false,
    available: true,
    cooldownMs: 0,
    successes: 0,
    failures: 0,
    totalCostUSD: 0,
    generatedTokens: 0,
    variants: [],
    groups: [],
    cost: [{ input: 1, output: 2 }],
    ...values,
  }
}

test("GUI catalog: search and sorting compare real cost, speed and TTFB without losing unknown metrics", () => {
  const cheap = model("a", "cheap", { cost: [{ input: 0, output: 0 }], free: true })
  const fast = model("b", "fast", {
    cost: [{ input: 2, output: 8 }],
    outputTokensPerSecond: 150,
    ttfbMs: 80,
  })
  const unknown = model("c", "unknown", { cost: undefined })
  const models = [unknown, fast, cheap]

  assert.deepEqual(
    organizeModels(models, { grouping: "route", sorting: "price" }).flatMap((section) => section.models.map((item) => item.id)),
    ["cheap", "fast", "unknown"],
  )
  assert.deepEqual(
    organizeModels(models, { grouping: "route", sorting: "speed" }).flatMap((section) => section.models.map((item) => item.id)),
    ["fast", "cheap", "unknown"],
  )
  assert.deepEqual(
    organizeModels(models, { search: "b/fast" }).flatMap((section) => section.models.map((item) => item.id)),
    ["fast"],
  )
  assert.equal(catalogPrice(unknown), Number.POSITIVE_INFINITY)
})

test("GUI catalog: provider, model, route, price and speed groupings include singleton models", () => {
  const models = [
    model("a", "same", { groups: ["auto:same"], outputTokensPerSecond: 150 }),
    model("b", "same", { groups: ["auto:same"], outputTokensPerSecond: 30 }),
    model("single", "solo", { cost: [{ input: 0, output: 0 }], free: true }),
  ]
  assert.equal(organizeModels(models, { grouping: "provider" }).length, 3)
  assert.equal(organizeModels(models, { grouping: "model" }).length, 2)
  assert.ok(
    organizeModels(models, { grouping: "route" })
      .find((section) => section.title === "Вне route-групп")
      ?.models.some((item) => item.id === "solo"),
  )
  assert.ok(organizeModels(models, { grouping: "price" }).some((section) => section.title === "Бесплатные"))
  assert.ok(organizeModels(models, { grouping: "speed" }).some((section) => section.title.startsWith("Быстрые")))
  assert.deepEqual(
    organizeModels(models, { enabledOnly: false }).flatMap((section) => section.models).length,
    3,
  )
  models[2].routingEnabled = false
  assert.equal(organizeModels(models, { enabledOnly: true }).flatMap((section) => section.models).length, 2)
})

test("GUI catalog: mixed currencies are grouped and sorted without numeric comparison", () => {
  const rub = model("rub", "cheap", { cost: [{ input: 1, output: 1 }], costCurrency: "RUB" })
  const usd = model("usd", "pricy", { cost: [{ input: 100, output: 100 }], costCurrency: "USD" })
  // Numerically RUB 2 < USD 200, but currencies order by code, never by exchange rate.
  assert.deepEqual(
    organizeModels([usd, rub], { grouping: "route", sorting: "price" })
      .flatMap((section) => section.models.map((item) => item.id)),
    ["cheap", "pricy"],
  )
  const titles = organizeModels([usd, rub], { grouping: "price" }).map((section) => section.title)
  assert.ok(titles.includes("Цены в RUB за 1M input + output"))
  assert.ok(titles.some((title) => title.includes("$")))
})

test("GUI catalog: formatting keeps price, balance, generation speed and latency units explicit", () => {
  assert.equal(formatPrice(0, "USD"), "$0")
  assert.equal(formatPrice(123, "RUB"), "₽123")
  assert.equal(formatPrice(5, "KZT"), "5 KZT")
  assert.equal(formatPrice(3), "3")
  assert.equal(formatPrice(undefined, "USD"), "—")
  assert.equal(formatBalance(168.25, "RUB"), "168,25 ₽")
  assert.equal(formatBalance(9.8, "USD"), "9,8 $")
  assert.equal(formatBalance(5, undefined), "5")
  assert.equal(formatBalance(undefined, "RUB"), "—")
  assert.equal(formatSpeed(125.25), "125,3 ток/с")
  assert.equal(formatLatency(80), "80 мс")
  assert.equal(formatLatency(1500), "1,5 с")
})
