import { Plugin } from "@opencode/plugin"
import { setupModelAutoRouter, type PluginContext } from "./core.ts"
import { ModelAutoRouterRpc } from "./rpc.ts"

export default Plugin.define({
  id: "opencode-model-autorouter",
  setup(ctx) {
    return setupModelAutoRouter(ctx as unknown as PluginContext, ModelAutoRouterRpc)
  },
})
