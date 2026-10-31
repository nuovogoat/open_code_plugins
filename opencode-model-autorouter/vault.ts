import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"
import { hostname, userInfo } from "node:os"

/**
 * Optional plugin-owned key vault. Keys are accepted through server RPC only,
 * encrypted at rest in plugin storage, and used exclusively for the hardcoded
 * account API origin of their provider. They are never returned by status/RPC,
 * never rendered in the GUI, and never handed to OpenCode provider settings.
 *
 * Threat model: protects against casual inspection of storage dumps and
 * accidental leakage into logs/status output. The encryption secret is derived
 * from a per-installation random salt bound to the machine/user; an attacker
 * with full read access to the storage directory can still decrypt it. This is
 * not a replacement for OS-level disk encryption.
 */

export interface VaultStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

/** Only providers with a confirmed account API may receive vault keys; a key never travels to any other origin. */
export const VAULT_PROVIDERS: readonly string[] = ["openrouter", "teamorouter", "plusvibe"]

const SECRET_STORAGE_KEY = "account-vault-secret-v1"
const ENTRY_PREFIX = "account-vault-v1:"

interface SecretRecord {
  salt: string
  providers: string[]
}

interface EncryptedRecord {
  v: 1
  iv: string
  tag: string
  data: string
}

function machineContext(): string {
  let user = ""
  try {
    user = userInfo().username
  } catch {
    // Some environments have no user info; the salt still binds the secret.
  }
  return `${hostname()}|${user}|opencode-model-autorouter`
}

function deriveKey(salt: string): Buffer {
  return scryptSync(`${salt}|${machineContext()}`, "opencode-model-autorouter-vault", 32)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export interface AccountVault {
  /** Stores an encrypted key; rejects providers without a confirmed account API. */
  set(providerID: string, key: string): Promise<void>
  /** Decrypts the stored key; tampered or malformed records resolve as absent. */
  get(providerID: string): Promise<string | undefined>
  clear(providerID: string): Promise<boolean>
  /** Provider IDs that currently have a vault key, in insertion order. */
  providers(): Promise<string[]>
}

/**
 * Without plugin storage the vault stays disabled; OpenCode connections remain
 * the only key source. Opening the vault only reads storage: the secret salt is
 * persisted lazily together with the first stored key, so a fresh install never
 * writes during router startup.
 */
export async function openAccountVault(storage: VaultStorage | undefined): Promise<AccountVault | undefined> {
  if (!storage) return undefined
  // Captured as a const so the closures below keep the narrowed reference.
  const store: VaultStorage = storage
  const persisted = record(await store.get(SECRET_STORAGE_KEY)) as SecretRecord | undefined
  const salt = typeof persisted?.salt === "string" && /^[0-9a-f]{64}$/u.test(persisted.salt)
    ? persisted.salt
    : randomBytes(32).toString("hex")
  const secret = deriveKey(salt)
  return {
    async set(providerID, key) {
      if (!VAULT_PROVIDERS.includes(providerID)) {
        throw new Error(`account keys are only accepted for: ${VAULT_PROVIDERS.join(", ")}`)
      }
      if (typeof key !== "string" || !key.trim() || key.length > 512) {
        throw new Error("account key must be a non-empty string of at most 512 characters")
      }
      const providers = await recordProviders()
      if (!providers.includes(providerID)) providers.push(providerID)
      await store.set(ENTRY_PREFIX + providerID, encrypt(secret, key.trim()))
      await saveSecret(providers)
    },
    async get(providerID) {
      const stored = record(await store.get(ENTRY_PREFIX + providerID))
      if (!stored) return undefined
      return decrypt(secret, stored)
    },
    async clear(providerID) {
      const providers = await recordProviders()
      const next = providers.filter((id) => id !== providerID)
      await store.remove(ENTRY_PREFIX + providerID)
      if (next.length === providers.length) return false
      await saveSecret(next)
      return true
    },
    providers: recordProviders,
  }

  async function recordProviders(): Promise<string[]> {
    const stored = record(await store.get(SECRET_STORAGE_KEY)) as SecretRecord | undefined
    if (!Array.isArray(stored?.providers)) return []
    return stored.providers.filter((id): id is string => VAULT_PROVIDERS.includes(id))
  }

  /** Always persists the exact salt the in-memory secret was derived from. */
  async function saveSecret(providers: string[]): Promise<void> {
    await store.set(SECRET_STORAGE_KEY, { salt, providers })
  }
}

function encrypt(secret: Buffer, value: string): EncryptedRecord {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", secret, iv)
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  }
}

function decrypt(secret: Buffer, stored: Record<string, unknown>): string | undefined {
  try {
    if (stored.v !== 1) return undefined
    if (typeof stored.iv !== "string" || typeof stored.tag !== "string" || typeof stored.data !== "string") {
      return undefined
    }
    const iv = Buffer.from(stored.iv, "base64")
    const tag = Buffer.from(stored.tag, "base64")
    const data = Buffer.from(stored.data, "base64")
    if (iv.length !== 12 || tag.length !== 16) return undefined
    const decipher = createDecipheriv("aes-256-gcm", secret, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
  } catch {
    // Tampered or corrupt records are treated as absent, never as an error surface.
    return undefined
  }
}
