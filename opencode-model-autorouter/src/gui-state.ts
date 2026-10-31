import type { ManualGroup, RouterStatus } from "./catalog.ts"

interface ScopedSession<Client> {
  pending: boolean
  location?: { directory: string }
  server: { client: Client }
}

export function routerScope<Client>(session: ScopedSession<Client> | undefined, revision: number) {
  return {
    revision,
    session,
    client: session?.server.client,
    location: session?.location
      ? { directory: session.location.directory }
      : undefined,
  }
}

export function manualGroupConfiguration(
  current: Pick<RouterStatus, "defaultGroup" | "manualGroups">,
  original: string,
  group: ManualGroup,
) {
  const groups = Object.fromEntries(
    current.manualGroups.map((item) => [
      item.name,
      { models: [...item.models], strategy: item.strategy },
    ]),
  )
  if (original && original !== group.name) delete groups[original]
  groups[group.name] = { models: [...group.models], strategy: group.strategy }
  return {
    groups,
    ...(current.defaultGroup === original && original !== group.name
      ? { defaultGroup: group.name }
      : {}),
  }
}
