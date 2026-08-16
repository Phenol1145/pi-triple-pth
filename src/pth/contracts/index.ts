/**
 * contracts/index.ts — PTH 内部契约层公共入口（2026-08-16 模块化 v2 P0-1）。
 *
 * 只导出纯类型与结构校验函数；本目录不得 import fastify / pg / redis /
 * @away_from/pth-sandbox 运行时实现。
 */

export * from "./identity.js";
export * from "./tasking.js";
export * from "./execution.js";
