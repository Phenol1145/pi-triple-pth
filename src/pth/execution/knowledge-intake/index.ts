/**
 * knowledge-intake/index.ts — Knowledge Intake 内部公开面（N29 Task 2 + Task 4 + Task 5）。
 *
 * 当前导出：
 *  - Trust Policy 验签与双阶段 matcher（Task 2）；
 *  - policy-bound fetch broker 与确定性 fetch/use 两阶段 admission（Task 4）；
 *  - strict KnowledgeIngestor、精确 evidence 构造与晋升前 source binding 复检（Task 5）。
 * service/due-scanner/repository 在后续 lane 接入。
 */
export * from "./trust-policy.js";
export * from "./fetch-broker.js";
export * from "./admission.js";
export * from "./knowledge-ingestor.js";
