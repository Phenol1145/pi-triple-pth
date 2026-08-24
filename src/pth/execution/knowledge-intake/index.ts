/**
 * knowledge-intake/index.ts — Knowledge Intake 内部公开面（N29 Task 2 + Task 4 + Task 5 + Task 6）。
 *
 * 当前导出：
 *  - Trust Policy 验签与双阶段 matcher（Task 2）；
 *  - policy-bound fetch broker 与确定性 fetch/use 两阶段 admission（Task 4）；
 *  - strict KnowledgeIngestor、精确 evidence 构造与晋升前 source binding 复检（Task 5）；
 *  - 内环状态机 service（fetch/extract/verify/promote + unchanged/changed 重爬 + stale/supersedes）
 *    与 due scanner（Task 6）。
 * PG repository 仍由 `kernel/storage` 提供——本层只声明结构化端口，不 import PG 适配器。
 */
export * from "./trust-policy.js";
export * from "./fetch-broker.js";
export * from "./admission.js";
export * from "./knowledge-ingestor.js";
export * from "./service.js";
export * from "./manual-control.js";
export * from "./due-scanner.js";
export * from "./source-discovery.js";
export * from "./auto-expansion.js";
export * from "./domain-classifier.js";
export * from "./production-defaults.js";
