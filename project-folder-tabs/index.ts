import { Plugin } from "@opencode/plugin"
import { setupProjectFolderTabs, type PluginContext } from "./core.ts"

export default Plugin.define({
  id: "project-folder-tabs",
  setup(ctx) {
    return setupProjectFolderTabs(ctx as unknown as PluginContext)
  },
})
