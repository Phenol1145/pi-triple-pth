/**
 * catalog/index.ts — catalog 模块公共 API（模块化 v2 P3）。
 * 跨模块消费方只允许 import 本文件。
 */
export * from "./runtime-catalog.js";
export * from "./catalog-builder.js";
export * from "./discipline-catalog.js";
export * from "./discipline-resolver.js";
export * from "./data/discipline-catalog-data.js";
export * from "./data/discipline-alias-overrides.js";
export * from "./data/pilot-source-registry.js";
export * from "./data/pilot-source-snapshots.js";
export * from "./data/pilot-knowledge.js";
export * from "./data/pilot-eval-queries.js";
export * from "./pilot-evaluator.js";
export * from "./capability-policy.js";
export * from "./role-routing-policy.js";
export * from "./space-lookup.js";
