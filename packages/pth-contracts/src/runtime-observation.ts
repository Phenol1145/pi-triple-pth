/**
 * contracts/runtime-observation.ts — N30 运行观测台只读 DTO 与 Freshness 契约（barrel）。
 *
 * 2026-08-24 非破坏性拆分：类型/常量移至 `runtime-observation-types.ts`，谓词/ID/Freshness
 * 工具移至 `runtime-observation-utils.ts`，结构校验移至 `runtime-observation-validators.ts`。
 * 本文件保留原路径并整体再导出，外部导入无需改动。
 *
 * 时间一律为 UTC epoch milliseconds；缺失资源指标保留 null，绝不合成 0。
 * Freshness 四态为 fresh / lagging / stale / disconnected，由显式注入时钟计算，
 * 任何调用方不能依赖进程本地时间获得确定性结果。
 */

export * from "./runtime-observation-types.js";
export * from "./runtime-observation-utils.js";
export * from "./runtime-observation-validators.js";
