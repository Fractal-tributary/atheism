import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/core";
import { a2aSpacePlugin } from "./src/channel.js";
import { setA2ARuntime } from "./src/runtime.js";

console.log("[a2aspace] Loading plugin...");

export default definePluginEntry({
  id: "a2aspace",
  name: "Atheism",
  description: "Atheism REST API channel connector for agent collaboration",
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
});
