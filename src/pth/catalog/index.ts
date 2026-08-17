/**
 * catalog/index.ts — catalog 模块公共 API（模块化 v2 P3）。
 * 跨模块消费方只允许 import 本文件。
 */
export * from "./runtime-catalog.js";
export * from "./catalog-builder.js";
export * from "./discipline-catalog.js";
export * from "./capability-policy.js";
export * from "./role-routing-policy.js";
export * from "./space-lookup.js";
