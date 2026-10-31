export type PermissionEffect = "allow" | "deny" | "ask"

export interface PermissionRule {
  action: string
  resource: string
  effect: PermissionEffect
}

export interface SessionPermissions {
  permissions?: PermissionRule[] | null
}

export interface AutonomyState {
  status: "off" | "enabling" | "on" | "disabling" | "error"
  acknowledged: boolean
  baseline?: PermissionRule[]
  expected?: PermissionRule[]
}

export const AUTONOMY_RULE: PermissionRule = {
  action: "*",
  resource: "*",
  effect: "allow",
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isPermissionRule(value: unknown): value is PermissionRule {
  if (!isRecord(value)) return false
  return (
    typeof value.action === "string" &&
    typeof value.resource === "string" &&
    (value.effect === "allow" || value.effect === "deny" || value.effect === "ask") &&
    Object.keys(value).every((key) => key === "action" || key === "resource" || key === "effect")
  )
}

export function readPermissions(value: unknown): PermissionRule[] {
  if (!isRecord(value)) throw new Error("Invalid session permissions")
  const session = isRecord(value.data) ? value.data : value
  const permissions = session.permissions
  if (permissions === undefined || permissions === null) return []
  if (!Array.isArray(permissions) || !permissions.every(isPermissionRule)) {
    throw new Error("Invalid session permissions")
  }
  return permissions.map((rule) => ({ ...rule }))
}

export function sameRules(left: readonly PermissionRule[], right: readonly PermissionRule[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function hasAutonomy(rules: readonly PermissionRule[]): boolean {
  return rules.some((rule) => sameRules([rule], [AUTONOMY_RULE]))
}

export function enabledRules(baseline: readonly PermissionRule[]): PermissionRule[] {
  return [...baseline.filter((rule) => !sameRules([rule], [AUTONOMY_RULE])), AUTONOMY_RULE].map((rule) => ({
    ...rule,
  }))
}

export interface Transition {
  accepted: boolean
  state: AutonomyState
  write?: PermissionRule[]
}

/**
 * A serialized, optimistic-concurrency state machine. Stale completions never
 * overwrite a newer user decision. Explicit deny rules are retained.
 */
export function transition(
  state: AutonomyState,
  event:
    | { type: "request-enable"; acknowledged: boolean }
    | { type: "request-disable" }
    | { type: "loaded"; generation: number; rules: PermissionRule[] }
    | { type: "written"; generation: number; rules: PermissionRule[] }
    | { type: "failed"; generation: number },
  generation: number,
): Transition {
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
        return {
          accepted: true,
          state: { ...state, status: "on", baseline: [], expected: [...event.rules] },
        }
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

export function disableWrite(
  current: readonly PermissionRule[],
  baseline: readonly PermissionRule[] | undefined,
): { kind: "restore" | "remove-marker" | "conflict"; rules?: PermissionRule[] } {
  if (!hasAutonomy(current)) return { kind: "restore", rules: [...current] }
  if (!baseline) {
    return {
      kind: "remove-marker",
      rules: current.filter((rule) => !sameRules([rule], [AUTONOMY_RULE])),
    }
  }
  if (!sameRules(current, enabledRules(baseline))) return { kind: "conflict" }
  return { kind: "restore", rules: baseline.map((rule) => ({ ...rule })) }
}

export function errorMessage(): string {
  return "Не удалось изменить режим. Проверьте соединение и повторите."
}

export function conflictMessage(): string {
  return "Правила изменились в другом месте. Автономный режим выключен; чужие изменения сохранены."
}
