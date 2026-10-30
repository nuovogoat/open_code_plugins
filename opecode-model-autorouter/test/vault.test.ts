import assert from "node:assert/strict"
import test from "node:test"
import { openAccountVault, VAULT_PROVIDERS, type VaultStorage } from "../vault.ts"
import { ModelAutoRouterRpc } from "../rpc.ts"
import { VAULT_PROVIDER_IDS } from "../src/catalog.ts"

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
  await vault.set("plusvibe", "  pv-secret-key  ")
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
  await first!.set("teamorouter", "teamo-key")
  const second = await openAccountVault(storage)
  assert.equal(await second!.get("teamorouter"), "teamo-key")
  assert.deepEqual(await second!.providers(), ["teamorouter"])
})

test("vault: tampered or malformed records resolve as absent instead of throwing", async () => {
  const storage = memoryStorage()
  const vault = (await openAccountVault(storage))!
  await vault.set("openrouter", "or-key")
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
  await vault.set("plusvibe", "pv-key")
  await vault.set("openrouter", "or-key")
  assert.deepEqual(await vault.providers(), ["plusvibe", "openrouter"])
  assert.equal(await vault.clear("plusvibe"), true)
  assert.equal(await vault.get("plusvibe"), undefined)
  assert.equal(storage.values.has("account-vault-v1:plusvibe"), false)
  assert.deepEqual(await vault.providers(), ["openrouter"])
  assert.equal(await vault.clear("plusvibe"), false)
  assert.equal(await vault.get("openrouter"), "or-key")
})

test("vault: only providers with a confirmed account API may store keys", async () => {
  const vault = (await openAccountVault(memoryStorage()))!
  await assert.rejects(vault.set("apimaster", "key"), /only accepted for/u)
  await assert.rejects(vault.set("", "key"), /only accepted for/u)
  assert.deepEqual(await vault.providers(), [])
})

test("vault: empty, blank and oversized keys are rejected", async () => {
  const vault = (await openAccountVault(memoryStorage()))!
  await assert.rejects(vault.set("plusvibe", ""), /non-empty string/u)
  await assert.rejects(vault.set("plusvibe", "   "), /non-empty string/u)
  await assert.rejects(vault.set("plusvibe", "k".repeat(513)), /non-empty string/u)
  assert.deepEqual(await vault.providers(), [])
})

test("vault: without plugin storage the vault stays disabled", async () => {
  assert.equal(await openAccountVault(undefined), undefined)
})

test("vault: provider lists stay in sync across vault, RPC schema and GUI catalog", () => {
  const rpcEnum = (
    ModelAutoRouterRpc.methods.setAccountKey.input as unknown as {
      properties: { providerID: { enum: readonly string[] } }
    }
  ).properties.providerID.enum
  assert.deepEqual([...rpcEnum], [...VAULT_PROVIDERS])
  assert.deepEqual([...VAULT_PROVIDER_IDS], [...VAULT_PROVIDERS])
})
