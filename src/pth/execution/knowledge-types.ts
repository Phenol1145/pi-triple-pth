/**
 * execution/knowledge-types.ts —— 执行层共享知识检索类型。
 *
 * 从 knowledge-broker.ts 抽出，供 knowledge-broker / layered-knowledge-retriever /
 * memory-directory / memory-type-classifier 等共同消费，避免 execution 内部 type-only 环。
 */

export interface KnowledgeMemoryEntry {
  id: string;
  kind: string;
  anchors: string[];
  status: string;
  content: string;
  meta?: Record<string, unknown>;
  /** N28 T3：repository 顶层租户字段（可选；Directory 输入会收紧为必填）。不镜像进 meta。 */
  tenantId?: string;
}

export interface KnowledgeSearchOpts {
  anchors?: string[];
  kinds?: string[];
  status?: string[];
  tenantId?: string;
  queryText?: string;
  limit?: number;
}
