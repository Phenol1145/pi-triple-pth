/**
 * kernel/storage/knowledge-intake-pg.ts — N29 Task 3：知识摄入内环的 PG 真相源仓库（barrel）。
 *
 * 2026-08-24 非破坏性拆分：支持类型/映射保留在 `knowledge-intake/support.ts`，
 * 仓库实现移至 `knowledge-intake-pg-repository.ts`；本文件保留原路径并整体再导出。
 */
export * from "./knowledge-intake/support.js";
export * from "./knowledge-intake-pg-repository.js";
