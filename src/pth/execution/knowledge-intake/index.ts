/**
 * knowledge-intake/index.ts — Knowledge Intake 内部公开面（N29 Task 2 + Task 4）。
 *
 * 当前导出：
 *  - Trust Policy 验签与双阶段 matcher（Task 2）；
 *  - policy-bound fetch broker 与确定性 fetch/use 两阶段 admission（Task 4）。
 * service/ingestor/repository 在后续 lane 接入。
 */
export * from "./trust-policy.js";
export * from "./fetch-broker.js";
export * from "./admission.js";
