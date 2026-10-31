// @ts-check

export const AUTONOMY_RULE = Object.freeze({ action: "*", resource: "*", effect: "allow" })

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isPermissionRule(value) {
  if (!isRecord(value)) return false
  return (
    typeof value.action === "string" &&
    typeof value.resource === "string" &&
    (value.effect === "allow" || value.effect === "deny" || value.effect === "ask") &&
    Object.keys(value).every((key) => key === "action" || key === "resource" || key === "effect")
  )
}

export function readPermissions(value) {
  if (!isRecord(value)) throw new Error("Invalid session permissions")
  const session = isRecord(value.data) ? value.data : value
  const permissions = session.permissions
  if (permissions === undefined || permissions === null) return []
  if (!Array.isArray(permissions) || !permissions.every(isPermissionRule)) {
    throw new Error("Invalid session permissions")
  }
  return permissions.map((rule) => ({ ...rule }))
}

export function sameRules(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function hasAutonomy(rules) {
  return rules.some((rule) => sameRules([rule], [AUTONOMY_RULE]))
}

export function enabledRules(baseline) {
  return [...baseline.filter((rule) => !sameRules([rule], [AUTONOMY_RULE])), AUTONOMY_RULE].map((rule) => ({
    ...rule,
  }))
}

/** Serialized optimistic-concurrency state machine. Stale completions are ignored. */
export function transition(state, event, generation) {
  if ("generation" in event && event.generation !== generation) return { accepted: false, state }

  switch (event.type) {
    case "request-enable":
      if (!event.acknowledged || state.status === "enabling" || state.status === "disabling") {
        return { accepted: false, state }
      }
      return {
        accepted: true,
        state: { ...state, status: "enabling", acknowledged: true, baseline: undefined, expected: undefined },
      }
    case "request-disable":
      if (state.status === "enabling" || state.status === "disabling") return { accepted: false, state }
      return { accepted: true, state: { ...state, status: "disabling" } }
    case "loaded": {
      if (state.status !== "enabling") return { accepted: false, state }
      if (hasAutonomy(event.rules)) {
        return { accepted: true, state: { ...state, status: "on", baseline: [], expected: [...event.rules] } }
      }
      const write = enabledRules(event.rules)
      return {
        accepted: true,
        state: { ...state, baseline: [...event.rules], expected: write },
        write,
      }
    }
    case "written":
      if (state.status !== "enabling" || !state.expected || !sameRules(event.rules, state.expected)) {
        return { accepted: false, state: { ...state, status: "error" } }
      }
      return { accepted: true, state: { ...state, status: "on" } }
    case "failed":
      return { accepted: true, state: { ...state, status: "error", expected: undefined } }
  }
}

export function disableWrite(current, baseline) {
  if (!hasAutonomy(current)) return { kind: "restore", rules: [...current] }
  if (!baseline) {
    return { kind: "remove-marker", rules: current.filter((rule) => !sameRules([rule], [AUTONOMY_RULE])) }
  }
  if (!sameRules(current, enabledRules(baseline))) return { kind: "conflict" }
  return { kind: "restore", rules: baseline.map((rule) => ({ ...rule })) }
}
