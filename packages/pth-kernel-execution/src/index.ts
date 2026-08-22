/**
 * @away_from/pth-kernel-execution —— PTH kernel 执行子包（execution/logger/prompt-docs/exec-channel）。
 *
 * 依赖方向：execution → interpreter / storage / config / memory / sandbox。
 * 同时作为 kernel 顶层门面，re-export interpreter/storage 公共 API 以兼容旧 kernel/index 消费面。
 * assembly.ts 保留在 src/pth/kernel（组合根，依赖 catalog/tasking），不放入本包。
 */
export * from "./concept-design.js";
export * from "./exec-channel.js";
export * from "./logger.js";
export * from "./prompt-docs.js";
export * from "./self-modify.js";
export * from "./execution/index.js";
export * from "@away_from/pth-kernel-storage";
