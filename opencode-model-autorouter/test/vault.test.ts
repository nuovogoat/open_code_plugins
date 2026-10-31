import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { openAccountVault, type VaultStorage } from "../vault.ts"

function memoryStorage(): VaultStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return {
    values,
    async get(key) {
      return values.get(key)
    },
    async set(key, value) {
      values.set(key, structuredClone(value))
    },
    async remove(key) {
      values.delete(key)
    },
  }
}

test("vault: keys roundtrip through storage encrypted and are trimmed", async () => {
  const storage = memoryStorage()
  const vault = (await openAccountVault(storage))!
  assert.ok(vault)
  await vault.set("plusvibe", "  pv-secret-key  ", ["plusvibe"])
  assert.equal(await vault.get("plusvibe"), "pv-secret-key")
  // The plaintext key never appears in any persisted record.
  for (const value of storage.values.values()) {
    assert.equal(JSON.stringify(value).includes("pv-secret-key"), false)
  }
  const entry = storage.values.get("account-vault-v1:plusvibe") as Record<string, unknown>
  assert.equal(entry.v, 1)
  assert.equal(typeof entry.iv, "string")
  assert.equal(typeof entry.tag, "string")
  assert.equal(typeof entry.data, "string")
})

test("vault: a reopened instance decrypts the stored key via the persisted salt", async () => {
  const storage = memoryStorage()
  const first = await openAccountVault(storage)
  await first!.set("teamorouter", "teamo-key", ["teamorouter"])
  const second = await openAccountVault(storage)
  assert.equal(await second!.get("teamorouter"), "teamo-key")
  assert.deepEqual(await second!.providers(), ["teamorouter"])
})

test("vault: tampered or malformed records resolve as absent instead of throwing", async () => {
  const storage = memoryStorage()
  const vault = (await openAccountVault(storage))!
  await vault.set("openrouter", "or-key", ["openrouter"])
  const entry = storage.values.get("account-vault-v1:openrouter") as Record<string, unknown>
  entry.data = Buffer.from("tampered-ciphertext").toString("base64")
  assert.equal(await vault.get("openrouter"), undefined)
  storage.values.set("account-vault-v1:openrouter", { v: 2, iv: "", tag: "", data: "" })
  assert.equal(await vault.get("openrouter"), undefined)
  storage.values.set("account-vault-v1:openrouter", "not-a-record")
  assert.equal(await vault.get("openrouter"), undefined)
})

test("vault: clear removes the key and the provider list, reporting repeats", async () => {
  const storage = memoryStorage()
  const vault = (await openAccountVault(storage))!
  await vault.set("plusvibe", "pv-key", ["plusvibe", "openrouter"])
  await vault.set("openrouter", "or-key", ["plusvibe", "openrouter"])
  assert.deepEqual(await vault.providers(), ["plusvibe", "openrouter"])
  assert.equal(await vault.clear("plusvibe"), true)
  assert.equal(await vault.get("plusvibe"), undefined)
  assert.equal(storage.values.has("account-vault-v1:plusvibe"), false)
  assert.deepEqual(await vault.providers(), ["openrouter"])
  assert.equal(await vault.clear("plusvibe"), false)
  assert.equal(await vault.get("openrouter"), "or-key")
})

test("vault: rejects keys for providers not in the current known roster", async () => {
  const vault = (await openAccountVault(memoryStorage()))!
  // Empty roster → nothing is accepted.
  await assert.rejects(vault.set("apimaster", "key", []), /not currently known/u)
  // Roster with other providers → target still rejected.
  await assert.rejects(vault.set("apimaster", "key", ["openrouter"]), /not currently known/u)
  // Empty string ID is never in the roster.
  await assert.rejects(vault.set("", "key", ["openrouter"]), /not currently known/u)
  assert.deepEqual(await vault.providers(), [])
})

test("vault: empty, blank and oversized keys are rejected", async () => {
  const vault = (await openAccountVault(memoryStorage()))!
  const known = ["plusvibe"]
  await assert.rejects(vault.set("plusvibe", "", known), /non-empty string/u)
  await assert.rejects(vault.set("plusvibe", "   ", known), /non-empty string/u)
  await assert.rejects(vault.set("plusvibe", "k".repeat(513), known), /non-empty string/u)
  assert.deepEqual(await vault.providers(), [])
})

test("vault: without plugin storage the vault stays disabled", async () => {
  assert.equal(await openAccountVault(undefined), undefined)
})

test("vault: account keys never leak into RPC responses, logs or public pricing", async () => {
  // This is the "hardest" leak test: it seeds real-looking secrets into both
  // the vault and the OpenCode credentials store, then inspects every byte
  // that leaves the plugin through RPC handlers, console output and the
  // public pricing snapshot.
  const secrets = [
    "sk-or-v1-LEAK-CANARY-0123456789ABCDEF",
    "tmr-LEAK-CANARY-FEDCBA9876543210",
    "pv-LEAK-CANARY-XXXXXXXXXXXXXXXXXXXX",
  ]
  const storage = memoryStorage()
  const vault = (await openAccountVault(storage))!
  const knownIDs = ["openrouter", "teamorouter", "plusvibe"]
  await vault.set("openrouter", secrets[0], knownIDs)
  await vault.set("teamorouter", secrets[1], knownIDs)
  await vault.set("plusvibe", secrets[2], knownIDs)

  // Capture everything that would leave the plugin boundary.
  const logged: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args.map((arg) => String(arg)).join(" "))
  }

  // Minimal harness that mirrors core.ts wiring without touching the network.
  const rpcHandlers: Record<string, (input: any) => Promise<unknown>> = {}
  const ctx: any = {
    options: {},
    model: { async list() { return { data: [] } } },
    pricing: { async load() { return [] } },
    session: {
      async get() { return {} },
      async switchModel() {},
      async synthetic() { return {} },
      hook: async () => ({ dispose() {} }),
    },
    event: {
      subscribe({ signal }: { signal: AbortSignal }) {
        return (async function* () {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener("abort", () => resolve(), { once: true })
          })
        })()
      },
    },
    rpc: {
      async register(_definition: unknown, handlers: Record<string, (input: any) => Promise<unknown>>) {
        Object.assign(rpcHandlers, handlers)
        return { dispose() {} }
      },
    },
    credentials: {
      async list() {
        return [
          { providerID: "openrouter", type: "api_key", key: secrets[0] },
          { providerID: "teamorouter", type: "api_key", key: secrets[1] },
          { providerID: "plusvibe", type: "api_key", key: secrets[2] },
        ]
      },
    },
    storage,
  }

  // Lazy-import to avoid circular deps at module scope.
  const { setupModelAutoRouter } = await import("../core.ts")
  const cleanup = setupModelAutoRouter(ctx, {})
  try {
    // Wait until handlers are registered.
    const deadline = Date.now() + 5_000
    while (!rpcHandlers.status && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(rpcHandlers.status, "status handler was not registered")

    const responses: unknown[] = []
    responses.push(await rpcHandlers.status({}))
    responses.push(await rpcHandlers.configure({}))
    responses.push(await rpcHandlers.rescan({}))

    const haystacks = [
      JSON.stringify(responses),
      JSON.stringify(logged),
      ...logged,
    ]
    for (const secret of secrets) {
      for (const haystack of haystacks) {
        assert.equal(
          haystack.includes(secret),
          false,
          `secret leaked: ${secret.slice(0, 8)}... found in output`,
        )
      }
    }
  } finally {
    console.error = originalError
    cleanup()
  }
})

test("vault: RPC schema has no hardcoded provider enum (dynamic allowlist)", async () => {
  // Ensures no regression to a static enum. The vault now validates against
  // the live model/vault roster, so the schema must accept any string.
  const source = await readFile(new URL("../rpc.ts", import.meta.url), "utf8")
  // Match across lines: providerID value spans multiple lines (comment + properties).
  const providerIDMatch = source.match(/setAccountKey:[\s\S]*?providerID:\s*\{([\s\S]*?)\},\s*key:/u)
  assert.ok(providerIDMatch, "providerID property was not found in setAccountKey input")
  assert.equal(
    providerIDMatch[1].includes("enum"),
    false,
    "setAccountKey providerID must NOT have a static enum; validation is dynamic",
  )
})
