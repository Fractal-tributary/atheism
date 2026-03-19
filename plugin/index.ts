import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { atheismPlugin } from "./src/channel.js";
import { setAtheismRuntime } from "./src/runtime.js";

console.log("[atheism] Loading plugin...");

const plugin = {
  id: "atheism",
  name: "Atheism",
  description: "Atheism REST API channel connector for agent collaboration",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    console.log("[atheism] register() called");
    
    // 设置 runtime
    setAtheismRuntime(api.runtime);
    
    // 注册 channel
    api.registerChannel({ plugin: atheismPlugin });
    
    console.log("[atheism] Channel registered");
    api.log?.info("atheism: plugin registered");
  },
};

console.log("[atheism] Plugin object created");

export default plugin;
