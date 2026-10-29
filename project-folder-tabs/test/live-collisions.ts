import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cli = process.env.OPENCODE_CLI
if (!cli) throw new Error("Set OPENCODE_CLI to the OpenCode CLI executable")

// Keep fixtures outside any repository: otherwise OpenCode resolves both
// directories to the enclosing repository instead of two separate projects.
const runID = `${process.pid}-${Date.now()}`
const base = join(tmpdir(), "opencode", `project-folder-tabs-collisions-${runID}`)
const parents = [`collision-a-${runID}`, `collision-b-${runID}`]
const projects = [
  { directory: join(base, parents[0], "frontend"), expected: `frontend — ${parents[0]}` },
  { directory: join(base, parents[1], "frontend"), expected: `frontend — ${parents[1]}` },
]
const created: string[] = []

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`opencode ${args[0]} timed out`))
    }, 30_000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`opencode ${args.join(" ")} failed (${code}): ${stderr || stdout}`))
    })
  })
}

async function getLocation(directory: string): Promise<any> {
  const output = await run([
    "api",
    "get",
    `/api/location?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
  ])
  const response = JSON.parse(output)
  return response.data ?? response
}

async function waitForPlugin(directory: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const output = await run([
      "api",
      "get",
      `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
    ])
    const plugins = JSON.parse(output).data
    const plugin = plugins?.find?.((item: any) => item.id === "project-folder-tabs")
    if (plugin?.state?.status === "active") return
    if (plugin?.state?.status === "error") throw new Error("Installed plugin failed to load")
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
  throw new Error("Installed plugin did not become active")
}

try {
  const projectIDs = new Set<string>()
  for (const project of projects) {
    await mkdir(project.directory, { recursive: true })
    const location = await getLocation(project.directory)
    assert.equal(location.project?.canonical, project.directory)
    assert.equal(location.directory, project.directory)
    assert.ok(location.project?.id)
    projectIDs.add(location.project.id)
    await waitForPlugin(project.directory)
  }
  assert.equal(projectIDs.size, projects.length)

  for (const [index, project] of projects.entries()) {
    const output = await run([
      "api",
      "session.create",
      "--data",
      JSON.stringify({
        title: `__LIVE_COLLISION_${index}__`,
        location: { directory: project.directory },
      }),
    ])
    const response = JSON.parse(output)
    if (response._tag || !response.data?.id) throw new Error("Session creation was rejected")
    created.push(response.data.id)
  }

  for (const [index, id] of created.entries()) {
    const expected = projects[index].expected
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const output = await run(["api", "session.get", "--param", `sessionID=${id}`])
      const session = JSON.parse(output).data
      if (session?.title === expected) break
      await new Promise((resolve) => setTimeout(resolve, 75))
    }
    const output = await run(["api", "session.get", "--param", `sessionID=${id}`])
    assert.equal(JSON.parse(output).data?.title, expected)
  }

  console.log(JSON.stringify({ collidingProjects: projects.length, createdAndDisambiguated: created.length }))
} finally {
  let cleanupFailures = 0
  for (const id of created) {
    try {
      await run(["api", "session.remove", "--param", `sessionID=${id}`])
    } catch {
      cleanupFailures++
    }
  }
  await rm(base, { recursive: true, force: true })
  console.log(JSON.stringify({ removedTestSessions: created.length - cleanupFailures, cleanupFailures }))
  if (cleanupFailures > 0) process.exitCode = 1
}
