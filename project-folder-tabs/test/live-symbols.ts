import { spawn } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { projectFolderName, type PluginLocation } from "../core.ts"

const cli = process.env.OPENCODE_CLI
if (!cli) throw new Error("Set OPENCODE_CLI to the OpenCode CLI executable")

const base = resolve(import.meta.dirname, "..", "test-results", `live-projects-${process.pid}`)
const names = [
  "проект",
  "项目🚀",
  "e\u0301",
  "עברית",
  "مرحبا",
  "👩🏽\u200d💻 project",
  "👨\u200d👩\u200d👧\u200d👦",
  "क्\u200cष",
  "x".repeat(120),
]
const sessionsPerProject = 3

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`OpenCode request failed (${code}): ${stderr || stdout}`))
    })
  })
}

async function mapLimit<T>(
  values: T[],
  limit: number,
  callback: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0
  async function worker() {
    while (next < values.length) {
      const value = values[next++]
      await callback(value)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
}

const created: Array<{ id: string; directory: string; expected: string }> = []
const started = performance.now()
try {
  await mkdir(base, { recursive: true })
  const projects = await Promise.all(
    names.map(async (name) => {
      const directory = join(base, name)
      await mkdir(directory)
      const output = await run([
        "api",
        "get",
        `/api/location?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
      ])
      const response = JSON.parse(output)
      const location = (response.data ?? response) as PluginLocation
      return { directory, expected: projectFolderName(location) }
    }),
  )

  const requests = projects.flatMap((project) =>
    Array.from({ length: sessionsPerProject }, (_, index) => ({ ...project, index })),
  )
  await mapLimit(requests, 6, async ({ directory, expected, index }) => {
    const output = await run([
      "api",
      "session.create",
      "--data",
      JSON.stringify({
        title: `__LIVE_SYMBOL_${index}_\u001b[2J\u202e_PRIVATE__`,
        location: { directory },
      }),
    ])
    const response = JSON.parse(output)
    if (response._tag || !response.data?.id) throw new Error("Session creation was rejected")
    created.push({ id: response.data.id, directory, expected })
  })

  await mapLimit(created, 6, async ({ id, expected }) => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const output = await run(["api", "session.get", "--param", `sessionID=${id}`])
      const session = JSON.parse(output).data
      if (session?.title === expected) return
      await new Promise((resolve) => setTimeout(resolve, 75))
    }
    throw new Error("A real Unicode project session was not renamed safely")
  })

  await mapLimit(projects, 4, async ({ directory }) => {
    const output = await run([
      "api",
      "get",
      `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
    ])
    const plugins = JSON.parse(output).data
    const plugin = plugins.find((item: any) => item.id === "project-folder-tabs")
    if (plugin?.state?.status !== "active") throw new Error("Installed plugin is not active")
  })

  console.log(
    JSON.stringify({
      unicodeProjects: projects.length,
      createdAndRenamed: created.length,
      elapsedMs: Math.round(performance.now() - started),
      activePluginLocations: projects.length,
    }),
  )
} finally {
  let removed = 0
  let cleanupFailures = 0
  await mapLimit(created, 6, async ({ id }) => {
    try {
      await run(["api", "session.remove", "--param", `sessionID=${id}`])
      removed++
    } catch {
      cleanupFailures++
    }
  })
  await rm(base, { recursive: true, force: true })
  console.log(JSON.stringify({ removedTestSessions: removed, cleanupFailures }))
  if (cleanupFailures > 0) process.exitCode = 1
}

console.log(await run(["service", "status"]))
