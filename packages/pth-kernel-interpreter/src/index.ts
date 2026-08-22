/**
 * @away_from/pth-kernel-interpreter —— PTH kernel 解释器子包（interpreter/extensions/ptc/templates/event-bus/space-registry）。
 *
 * 依赖方向：interpreter → kernel-storage / pth-memory / pth-sandbox；不依赖 kernel-execution。
 */
export * from "./interpreter/index.js";
export * from "./extensions/index.js";
export * from "./extensions/perf-params.js";
export * from "./extensions/model.js";
export {
  ExtRegistry,
  buildStdExtChannels,
  defaultExtOnError,
  type ExtRegistryOptions,
  type LoadedExt,
} from "./extensions/ext-registry.js";
export * from "./execution/tool-registry.js";
export * from "./execution/debug-case-dispatch.js";
export * from "./ptc/contract.js";
export * from "./ptc/docs.js";
export * from "./ptc/runner.js";
export * from "./ptc/surface.js";
export * from "./ptc/tools.js";
export * from "./templates.js";
export * from "./mcp-decompose.js";
export * from "./execution/event-bus.js";
export * from "./execution/space-registry.js";
