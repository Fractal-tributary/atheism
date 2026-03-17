import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { a2aSpacePlugin } from "./src/channel.js";
import { setA2ARuntime } from "./src/runtime.js";

console.log("[a2aspace] Loading plugin...");

const plugin = {
  id: "a2aspace",
  name: "A2A Space",
  description: "A2A Space REST API channel connector for agent collaboration",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    console.log("[a2aspace] register() called");
    
    // 设置 runtime
    setA2ARuntime(api.runtime);
    
    // 注册 channel
    api.registerChannel({ plugin: a2aSpacePlugin });
    
    console.log("[a2aspace] Channel registered");
    api.log?.info("a2aspace: plugin registered");
  },
};

console.log("[a2aspace] Plugin object created");

export default plugin;
