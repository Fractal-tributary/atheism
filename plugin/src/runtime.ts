import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setA2ARuntime(r: PluginRuntime) {
  runtime = r;
}

export function getA2ARuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("A2A Space runtime not initialized");
  }
  return runtime;
}
