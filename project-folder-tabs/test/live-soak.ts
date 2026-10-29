import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"

const cli = process.env.OPENCODE_CLI
if (!cli) throw new Error("Set OPENCODE_CLI to the OpenCode CLI executable")

function numberOption(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`)
  return value
}

const durationMs = numberOption("SOAK_DURATION_MS", 30 * 60_000)
const intervalMs = numberOption("SOAK_INTERVAL_MS", 5_000)
const sampleIntervalMs = numberOption("SOAK_SAMPLE_INTERVAL_MS", 30_000)
const maxPrivateGrowth = numberOption("SOAK_MAX_PRIVATE_GROWTH_BYTES", 256 * 1024 * 1024)
const runID = `${process.pid}-${Date.now()}`
const base = join(tmpdir(), "opencode", `project-folder-tabs-soak-${runID}`)
const parents = [`soak-a-${runID}`, `soak-b-${runID}`]
const projects = [
  { directory: join(base, parents[0], "frontend"), expected: `frontend — ${parents[0]}` },
  { directory: join(base, parents[1], "frontend"), expected: `frontend — ${parents[1]}` },
]
const created = new Set<string>()
let cleanupFailures = 0

function execute(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let failure: Error | undefined
    const stop = (message: string) => {
      failure ??= new Error(message)
      child.kill()
    }
    const timer = setTimeout(() => stop("soak command timed out"), 30_000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (stdout.length + stderr.length > 4_000_000) stop("soak output limit exceeded")
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      if (stdout.length + stderr.length > 4_000_000) stop("soak output limit exceeded")
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (code === 0) resolve(stdout.trim())
      else reject(new Error(`soak command failed (${code}): ${stderr || stdout}`))
    })
  })
}

function run(args: string[]): Promise<string> {
  return execute(cli, args)
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
  if (result?._tag) throw new Error(`${operation} was rejected`)
  return result
}

async function removeSession(id: string): Promise<void> {
  try {
    await api("session.remove", { params: { sessionID: id } })
    created.delete(id)
  } catch {
    cleanupFailures++
  }
}

async function activePluginLocations(): Promise<number> {
  let active = 0
  for (const project of projects) {
    const output = await run([
      "api",
      "get",
      `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project.directory)}`,
    ])
    const plugins = JSON.parse(output).data
    const matches = plugins?.filter?.((item: any) => item.id === "project-folder-tabs") ?? []
    assert.ok(matches.length <= 1, "duplicate plugin instance detected")
    if (matches[0]?.state?.status === "active") active++
  }
  return active
}

async function waitForActivePlugins(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await activePluginLocations() === projects.length) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail("plugin instances did not become active")
}

async function createAndVerifySessions(): Promise<void> {
  await Promise.all(
    projects.map(async (project, index) => {
      const response = await api("session.create", {
        data: {
          title: `__SOAK_${runID}_${index}__`,
          location: { directory: project.directory },
        },
      })
      const id = response.data?.id
      assert.equal(typeof id, "string")
      created.add(id)

      const deadline = Date.now() + 30_000
      let actual: unknown
      while (Date.now() < deadline) {
        const session = await api("session.get", { params: { sessionID: id } })
        actual = session.data?.title
        if (actual === project.expected) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.equal(actual, project.expected)
    }),
  )
}

interface ServerMetrics {
  privateBytes: number
  workingSetBytes: number
  handles: number | null
}

async function serverMetrics(pid: number): Promise<ServerMetrics> {
  if (platform() === "win32") {
    const script = `Get-Process -Id ${pid} | Select-Object PrivateMemorySize64,WorkingSet64,HandleCount | ConvertTo-Json -Compress`
    const result = JSON.parse(
      await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]),
    )
    return {
      privateBytes: result.PrivateMemorySize64,
      workingSetBytes: result.WorkingSet64,
      handles: result.HandleCount,
    }
  }

  const output = await execute("ps", ["-p", String(pid), "-o", "rss=,vsz="])
  const [rssKiB, virtualKiB] = output.trim().split(/\s+/u).map(Number)
  return {
    privateBytes: rssKiB * 1024,
    workingSetBytes: rssKiB * 1024,
    handles: null,
  }
}

async function sample(pid: number, cycle: number, started: number) {
  const memory = await serverMetrics(pid)
  const active = await activePluginLocations()
  assert.equal(active, projects.length)
  const point = {
    elapsedMs: Date.now() - started,
    cycle,
    activePluginLocations: active,
    serverPrivateBytes: memory.privateBytes,
    serverWorkingSetBytes: memory.workingSetBytes,
    serverHandles: memory.handles,
  }
  console.log(JSON.stringify({ soakSample: point }))
  return point
}

try {
  for (const project of projects) {
    await mkdir(project.directory, { recursive: true })
    const output = await run([
      "api",
      "get",
      `/api/location?location%5Bdirectory%5D=${encodeURIComponent(project.directory)}`,
    ])
    const location = JSON.parse(output)
    assert.equal((location.data ?? location).project?.canonical, project.directory)
  }
  await waitForActivePlugins()

  // Warm caches and JIT before taking the baseline, then verify every cycle.
  await createAndVerifySessions()
  await Promise.all([...created].map(removeSession))
  assert.equal(created.size, 0)

  const server = JSON.parse(await run(["api", "get", "/api/info"]))
  const pid = server.pid
  assert.ok(Number.isInteger(pid) && pid > 0)
  const started = Date.now()
  const baseline = await sample(pid, 0, started)
  const deadline = started + durationMs
  let nextSample = started + sampleIntervalMs
  let cycles = 0

  while (Date.now() < deadline) {
    const cycleStarted = Date.now()
    await createAndVerifySessions()
    await Promise.all([...created].map(removeSession))
    assert.equal(created.size, 0)
    cycles++
    if (Date.now() >= nextSample) {
      await sample(pid, cycles, started)
      nextSample = Date.now() + sampleIntervalMs
    }
    const remaining = intervalMs - (Date.now() - cycleStarted)
    if (remaining > 0 && Date.now() + remaining < deadline) {
      await new Promise((resolve) => setTimeout(resolve, remaining))
    }
  }

  const final = await sample(pid, cycles, started)
  const privateGrowth = final.serverPrivateBytes - baseline.serverPrivateBytes
  const handleGrowth =
    final.serverHandles !== null && baseline.serverHandles !== null
      ? final.serverHandles - baseline.serverHandles
      : null
  assert.ok(
    privateGrowth <= maxPrivateGrowth,
    `server private memory grew by ${privateGrowth} bytes`,
  )
  assert.equal(cleanupFailures, 0)
  console.log(
    JSON.stringify({
      soak: "ok",
      durationMs: Date.now() - started,
      cycles,
      sessionsCreatedAndRemoved: cycles * projects.length,
      activePluginLocations: final.activePluginLocations,
      privateGrowthBytes: privateGrowth,
      handleGrowth,
    }),
  )
} finally {
  await Promise.all([...created].map(removeSession))
  await rm(base, { recursive: true, force: true })
  console.log(JSON.stringify({ remainingTestSessions: created.size, cleanupFailures }))
  if (created.size > 0 || cleanupFailures > 0) process.exitCode = 1
}
