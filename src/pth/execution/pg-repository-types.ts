/**
 * execution/pg-repository-types.ts —— 执行域 PG 适配器共用最小查询面（barrel）。
 *
 * 统一类型与 JSON 解析助手已移至 `src/pth/shared/pg-queryable.ts`；本文件保留路径再导出，
 * 避免执行域既有导入改动。
 */
export * from "../shared/pg-queryable.js";
