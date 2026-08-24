/**
 * knowledge-verdicts.ts —— K4 Phase 4（N22 1）候选验证 verdict 契约与纯函数（barrel）。
 *
 * 2026-08-24 非破坏性拆分：类型契约移至 `knowledge-verdicts-types.ts`，hash 纯函数移至
 * `knowledge-verdicts-hash.ts`，verdict 校验/绑定门禁/晋升判定移至 `knowledge-verdicts-core.ts`。
 * 本文件保留原路径并整体再导出，外部导入无需改动。
 */

export * from "./knowledge-verdicts-types.js";
export * from "./knowledge-verdicts-hash.js";
export * from "./knowledge-verdicts-core.js";
