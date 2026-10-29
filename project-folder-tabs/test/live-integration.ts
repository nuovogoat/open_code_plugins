import { spawn } from "node:child_process"
import { resolve } from "node:path"

const cli = process.env.OPENCODE_CLI
if (!cli) throw new Error("Set OPENCODE_CLI to the OpenCode CLI executable")

const directory = resolve(import.meta.dirname, "..", "..")
const expectedTitle = "open_code_session_marker"
const sessionCount = Number(process.env.STRESS_SESSIONS ?? "64")
const prefix = `__project_folder_tabs_live_${Date.now()}__`

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
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
      else if (code === 0) resolve(stdout.trim())
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

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  callback: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  async function worker() {
    while (next < values.length) {
      const index = next++
      results[index] = await callback(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return results
}

const created: string[] = []
const started = performance.now()
try {
  await mapLimit(Array.from({ length: sessionCount }, (_, index) => index), 8, async (index) => {
    const response = await api("session.create", {
      data: { title: `${prefix}${index}`, location: { directory } },
    })
    created.push(response.data.id)
  })

  const deadline = Date.now() + 20_000
  const remaining = new Set(created)
  while (remaining.size > 0 && Date.now() < deadline) {
    const page = await api("session.list", {
      params: { directory, limit: String(Math.max(100, sessionCount + 10)) },
    })
    for (const session of page.data) {
      if (remaining.has(session.id) && session.title === expectedTitle) {
        remaining.delete(session.id)
      }
    }
    if (remaining.size > 0) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (remaining.size > 0) {
    throw new Error(`${remaining.size} new sessions were not renamed: ${[...remaining].join(", ")}`)
  }

  const pluginOutput = await run([
    "api",
    "get",
    `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
  ])
  const plugins = JSON.parse(pluginOutput)
  const plugin = plugins.data?.find?.((item: any) => item.id === "project-folder-tabs")
  if (!plugin || plugin.state?.status !== "active") {
    throw new Error(`Plugin is not active: ${JSON.stringify(plugin ?? plugins)}`)
  }

  console.log(
    JSON.stringify({
      createdAndRenamed: created.length,
      elapsedMs: Math.round(performance.now() - started),
      plugin: plugin.state.status,
    }),
  )
} finally {
  const ids = [...created]
  const removed: string[] = []
  const cleanupFailures: string[] = []
  await mapLimit(ids, 8, async (id) => {
    try {
      await api("session.remove", { params: { sessionID: id } })
      removed.push(id)
    } catch {
      cleanupFailures.push(id)
    }
  })
  console.log(
    JSON.stringify({ removedTestSessions: removed.length, cleanupFailures: cleanupFailures.length }),
  )
  if (cleanupFailures.length > 0) process.exitCode = 1
}

console.log(await run(["service", "status"]))
