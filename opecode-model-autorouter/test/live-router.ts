import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { relative, resolve, join } from "node:path"

const cli = process.env.OPENCODE_CLI
if (!cli) throw new Error("Set OPENCODE_CLI to the OpenCode CLI executable")

const pluginRoot = resolve(import.meta.dirname, "..")
const results = resolve(pluginRoot, "test-results")
await mkdir(results, { recursive: true })
const directory = await mkdtemp(join(results, "live-project-"))
const packagePath = relative(directory, pluginRoot).replaceAll("\\", "/")
await writeFile(
  join(directory, "opencode.json"),
  JSON.stringify({
    plugins: [{ package: packagePath, options: { rescanIntervalMs: 600_000 } }],
  }),
)

function run(args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(cli!, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let failure: Error | undefined
    const stop = (message: string) => {
      failure ??= new Error(message)
      child.kill()
    }
    const timer = setTimeout(() => stop(`opencode ${args[0]} timed out`), 30_000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (stdout.length + stderr.length > 4_000_000) stop("CLI output limit exceeded")
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      if (stdout.length + stderr.length > 4_000_000) stop("CLI output limit exceeded")
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (code === 0) resolveOutput(stdout.trim())
      else reject(new Error(`opencode ${args.join(" ")} failed (${code}): ${stderr || stdout}`))
    })
  })
}

async function api(
  operation: string,
  options: { params?: Record<string, string>; data?: unknown } = {},
): Promise<any> {
  const args = ["api", operation]
  for (const [key, value] of Object.entries(options.params ?? {})) {
    args.push("--param", `${key}=${value}`)
  }
  if (options.data !== undefined) args.push("--data", JSON.stringify(options.data))
  const output = await run(args)
  const result = output ? JSON.parse(output) : undefined
  if (result?._tag) throw new Error(`${operation}: ${JSON.stringify(result)}`)
  return result
}

const location = `location%5Bdirectory%5D=${encodeURIComponent(directory)}`
async function call(method: string, input: unknown = {}): Promise<any> {
  const output = await run([
    "api",
    "post",
    `/api/rpc/opecode-model-autorouter/${method}?${location}`,
    "--data",
    JSON.stringify({ input }),
  ])
  const result = output ? JSON.parse(output) : undefined
  if (result?._tag) throw new Error(`${method}: ${JSON.stringify(result)}`)
  return result?.output
}

async function eventually<T>(callback: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await callback()
    } catch (error) {
      lastError = error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
    }
  }
  throw lastError instanceof Error ? lastError : new Error("live condition was not reached")
}

let sessionID: string | undefined
try {
  const created = await api("session.create", {
    data: { title: `__model_router_live_${Date.now()}__`, location: { directory } },
  })
  sessionID = created.data.id

  await eventually(async () => {
    const plugins = JSON.parse(await run(["api", "get", `/api/plugin?${location}`]))
    const plugin = plugins.data?.find?.((item: any) => item.id === "opecode-model-autorouter")
    assert.equal(plugin?.state?.status, "active", JSON.stringify(plugin ?? plugins))
  })

  await eventually(async () => {
    const value = await call("status")
    assert.equal(value.enabled, true)
  })
  const status = await eventually(async () => {
    const value = await call("rescan")
    assert.equal(value.enabled, true)
    assert.equal(value.autoDiscover, true)
    assert.ok(value.modelsDiscovered > 0)
    return value
  })
  assert.ok(status.groups.length > 0, "connected live providers have no equivalent model IDs")
  assert.ok(
    status.groups.every((group: any) =>
      group.candidates.every((candidate: any) => typeof candidate.model === "string"),
    ),
  )
  const serialized = JSON.stringify(status)
  assert.equal(serialized.includes(directory), false)
  assert.equal(serialized.includes("__model_router_live"), false)

  const candidate = status.groups[0].candidates[0].model
  const selected = await call("select", { sessionID, model: candidate })
  assert.equal(selected.selected, candidate)
  const session = await api("session.get", { params: { sessionID } })
  assert.equal(session.data.model.providerID, candidate.split("/")[0])

  console.log(
    JSON.stringify({
      plugin: "active",
      modelsDiscovered: status.modelsDiscovered,
      automaticGroups: status.groups.filter((group: any) => group.automatic).length,
      manualGroups: status.groups.filter((group: any) => !group.automatic).length,
      selected,
      promptsSent: 0,
    }),
  )
} finally {
  let cleanupFailed = false
  if (sessionID) {
    try {
      await api("session.remove", { params: { sessionID } })
    } catch {
      cleanupFailed = true
    }
  }
  try {
    await rm(directory, { recursive: true, force: true })
  } catch {
    cleanupFailed = true
  }
  if (cleanupFailed) process.exitCode = 1
}
