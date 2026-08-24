/**
 * contracts/tasking.ts — 任务认领/执行/提交的跨模块协议（barrel）。
 *
 * 2026-08-24 非破坏性拆分：类型/常量移至 `tasking-types.ts`，结构校验移至
 * `tasking-validation.ts`，提交/投递/结果编码工具移至 `tasking-utils.ts`。
 * 本文件保留原路径并整体再导出，外部导入无需改动。
 */

export * from "./tasking-types.js";
export * from "./tasking-validation.js";
export * from "./tasking-utils.js";
