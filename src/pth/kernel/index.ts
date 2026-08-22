/**
 * kernel/index.ts — kernel 模块公共 API（模块化优化 P3c barrel 纪律）。
 *
 * gateway/application 等跨模块消费方只允许 import 本文件（或 contracts），
 * 不再直引 kernel 私有文件。
 */
export * from "./assembly.js";
export * from "./execution/role-router.js";
export * from "./execution/worker-cluster.js";
export * from "./execution/optimizer-apply.js";
export * from "./execution/worker-scorecard.js";
export * from "./prompt-docs.js";
export * from "./templates.js";
export * from "./storage/index.js";
