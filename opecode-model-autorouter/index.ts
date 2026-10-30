import { Plugin } from "@opencode/plugin"
import { setupModelAutoRouter, type PluginContext } from "./core.ts"
import { ModelAutoRouterRpc } from "./rpc.ts"

export default Plugin.define({
  id: "opecode-model-autorouter",
  setup(ctx) {
    return setupModelAutoRouter(ctx as unknown as PluginContext, ModelAutoRouterRpc)
  },
})
