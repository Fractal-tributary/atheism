import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setAtheismRuntime(r: PluginRuntime) {
  runtime = r;
}

export function getAtheismRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Atheism runtime not initialized");
  }
  return runtime;
}
