import assert from "node:assert/strict"
import test from "node:test"
import {
  folderName,
  projectFolderName,
  syncExistingSessions,
  watchCreatedSessions,
  type CreatedSessionEvent,
  type PluginContext,
  type SessionInfo,
} from "../core.ts"

function location(): PluginContext["location"] {
  return {
    directory: "C:\\stress\\checkout",
    project: {
      id: "stress-project",
      directory: "C:\\stress\\checkout",
      canonical: "C:\\stress\\project",
    },
  }
}

test("stress: 12,050 sessions, 121 pages, bounded concurrency and partial failures", async () => {
  const title = "project"
  const sessions: SessionInfo[] = Array.from({ length: 12_050 }, (_, index) => ({
    id: `ses_${index}`,
    title: index % 7 === 0 ? title : `Old title ${index}`,
  }))
  const expectedFailures = sessions.filter(
    (session, index) => session.title !== title && index % 997 === 0,
  ).length
  let active = 0
  let maximumActive = 0
  let renamed = 0
  let failed = 0

  const ctx: PluginContext = {
    location: location(),
    session: {
      async hook() {},
      async list(input) {
        const offset = input.cursor ? Number(input.cursor) : 0
        return {
          data: sessions.slice(offset, offset + 100),
          cursor:
            offset + 100 < sessions.length
              ? { next: String(offset + 100) }
              : {},
        }
      },
      async update(input) {
        active++
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setImmediate(resolve))
        try {
          const index = Number(input.sessionID.slice(4))
          if (index % 997 === 0) {
            failed++
            throw new Error(`injected failure ${index}`)
          }
          sessions[index].title = input.title
          renamed++
        } finally {
          active--
        }
      },
    },
    event: {
      subscribe() {
        return (async function* () {})()
      },
    },
  }

  const stats = await syncExistingSessions(ctx, title)

  assert.ok(maximumActive > 1)
  assert.ok(maximumActive <= 8, `maximum concurrency: ${maximumActive}`)
  assert.equal(stats.pages, 121)
  assert.equal(stats.failed, expectedFailures)
  assert.equal(stats.renamed, renamed)
  assert.equal(failed, expectedFailures)
  assert.equal(renamed + failed, 10_328)
  assert.equal(active, 0)
  assert.ok(
    sessions.every(
      (session, index) =>
        session.title === title ||
        (index % 997 === 0 && session.title === `Old title ${index}`),
    ),
  )
})

test("stress: 15,000 mixed events and injected update failures never reject", async () => {
  const events: CreatedSessionEvent[] = Array.from({ length: 15_000 }, (_, index) => {
    if (index % 11 === 0) return { type: "session.created" }
    if (index % 11 === 1) {
      return {
        type: "session.updated",
        data: { sessionID: `ses_${index}`, projectID: "stress-project" },
      }
    }
    return {
      type: "session.created",
      data: {
        sessionID: `ses_${index}`,
        projectID: index % 13 === 0 ? "another-project" : "stress-project",
        title: index % 17 === 0 ? "project" : "Session",
      },
    }
  })
  const expected = events.filter((event) => {
    const data = event.data
    return (
      event.type === "session.created" &&
      data?.projectID === "stress-project" &&
      data.title !== "project" &&
      typeof data.sessionID === "string" &&
      data.sessionID.length > 0
    )
  }).length
  let updates = 0
  let failures = 0

  const ctx: PluginContext = {
    location: location(),
    session: {
      async hook() {},
      async list() {
        return { data: [] }
      },
      async update(input) {
        updates++
        if (Number(input.sessionID.slice(4)) % 1009 === 0) {
          failures++
          throw new Error("injected update failure")
        }
      },
    },
    event: {
      subscribe() {
        return (async function* () {
          for (const event of events) {
            yield event
            if (updates % 100 === 0) await new Promise((resolve) => setImmediate(resolve))
          }
          throw new Error("injected stream failure")
        })()
      },
    },
  }

  await watchCreatedSessions(ctx, "project", new AbortController().signal)
  assert.equal(updates, expected)
  assert.ok(failures > 0)
})

test("stress/fuzz: 20,000 unusual and very long paths stay synchronous and safe", () => {
  const alphabet = ["a", " ", ".", ":", "\\", "/", "п", "🚀", "\u0000", "\n"]
  let state = 0x12345678
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }

  for (let index = 0; index < 20_000; index++) {
    const length = index === 0 ? 100_000 : Math.floor(random() * 300)
    let path = ""
    for (let char = 0; char < length; char++) {
      path += alphabet[Math.floor(random() * alphabet.length)]
    }

    const name = folderName(path)
    assert.equal(typeof name, "string")
    assert.doesNotThrow(() =>
      projectFolderName({
        directory: path,
        project: { id: "fuzz", directory: path, canonical: path },
      }),
    )
    if (name) assert.equal(name.includes("/"), false)
  }
})
