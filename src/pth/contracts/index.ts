/**
 * contracts/index.ts — PTH 内部契约层公共入口（2026-08-16 模块化 v2 P0-1）。
 *
 * 只导出纯类型与结构校验函数；本目录不得 import fastify / pg / redis /
 * @away_from/pth-sandbox 运行时实现。
 */

export * from "./identity.js";
export * from "./domains.js";
export * from "./tasking.js";
export * from "./execution.js";
export * from "./catalog-contribution-schema.js";
export * from "./role-routing-policy.js";
export * from "./program.js";
export * from "./cognitive-responsibility.js";
export * from "./knowledge-intake.js";
export * from "./runtime-observation.js";
export * from "./work-mode.js";
export * from "./professional-computing.js";
export * from "./notebook-guide.js";
export * from "./system-inspection.js";
