import assert from "node:assert/strict"
import test from "node:test"
import type { RouterStatus } from "../src/catalog.ts"
import { manualGroupConfiguration, routerScope } from "../src/gui-state.ts"

test("GUI scope: catalog and RPC options use the selected session server and location", () => {
  const wrongClient = { name: "wrong" }
  const selectedClient = { name: "selected" }
  const scope = routerScope({
    pending: false,
    location: { directory: "C:/selected-project" },
    server: { client: selectedClient },
  }, 4)
  assert.equal(scope.client, selectedClient)
  assert.notEqual(scope.client, wrongClient)
  assert.equal(scope.revision, 4)
  assert.deepEqual(scope.location, { directory: "C:/selected-project" })
  assert.equal(routerScope(undefined, 5).client, undefined)
})

test("GUI groups: renaming the default group updates defaultGroup in the same patch", () => {
  const current: Pick<RouterStatus, "defaultGroup" | "manualGroups"> = {
    defaultGroup: "old",
    manualGroups: [
      { name: "old", strategy: "manual", models: ["a/one"] },
      { name: "other", strategy: "fastest", models: ["b/two"] },
    ],
  }
  const patch = manualGroupConfiguration(current, "old", {
    name: "new",
    strategy: "cheapest",
    models: ["a/one", "b/two#max"],
  })
  assert.equal(patch.defaultGroup, "new")
  assert.deepEqual(Object.keys(patch.groups), ["other", "new"])
  assert.deepEqual(patch.groups.new, {
    strategy: "cheapest",
    models: ["a/one", "b/two#max"],
  })

  const nonDefault = manualGroupConfiguration(
    { ...current, defaultGroup: "other" },
    "old",
    { name: "new", strategy: "manual", models: ["a/one"] },
  )
  assert.equal("defaultGroup" in nonDefault, false)
})
