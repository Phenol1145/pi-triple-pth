/**
 * execution/memory-type-classifier.ts —— N28 T3 记忆五类投影边界（v1.3 P0 增加 index）。
 *
 * memoryType 由 Knowledge 边界的规范化分类投影提供；不从 prose/anchors 猜测，
 * 不另造 kind→五类记忆的第二套真相。可行性 mapping 冻结且穷尽；
 * 未知 kind 返回 undefined——Directory 构建 fail-closed，直到 repository adapter
 * 提供 approved mapping。真实 store adapter 为后续工作。
 */

import type { MemoryType } from "../contracts/index.js";
import type { KnowledgeMemoryEntry } from "./knowledge-broker.js";

export type MemoryTypeClassifier = (entry: Pick<KnowledgeMemoryEntry, "kind">) => MemoryType | undefined;

const FEASIBILITY_KIND_TO_MEMORY_TYPE: Readonly<Record<string, MemoryType>> = Object.freeze({
  "domain-fact": "wiki",
  "domain-method": "wiki",
  "pth-wiki": "wiki",
  "system-setting": "setting",
  "role-definition": "setting",
  config: "setting",
  skill: "skill",
  "skill-index": "skill",
  "task-insight": "log",
  "episodic-log": "log",
  // v1.3 P0：Index Memory 只存导航元数据——三类 kind 都投影为 index，绝不映射进正文四类。
  "source-index": "index",
  "symbol-index": "index",
  "memory-collection-index": "index",
});

export const classifyFeasibilityMemoryType: MemoryTypeClassifier = (entry) =>
  FEASIBILITY_KIND_TO_MEMORY_TYPE[entry.kind];
