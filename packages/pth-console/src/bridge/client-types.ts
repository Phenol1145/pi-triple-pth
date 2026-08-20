/**
 * bridge/client-types.ts —— PTH HTTP 客户端 DTO 类型（模块专项 ② 大文件拆分：自 client.ts 抽出）。
 */
import type { ProgramManifest, ComponentManifest } from "./manifest.js";

/** SSE 事件 */
export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Submit 响应 */
export interface SubmitResponse {
  name: string;
  version: number;
  bytes: number;
  /** respond 关联闭合信息（评审 WP4-R1 I-2：PTL 需感知闭合结果，不得无条件宣称成功） */
  closedRequest?: string;
  closeWarning?: string;
}

/** Programs 列表条目 */
export interface ProgramEntry {
  name: string;
  latestVersion: number;
  updatedAt: string;
}

/** 观测会话 meta（F/WP4 Task 21——与 pth storage/types 的 SessionMeta 同构，本地镜像类型防跨层 import） */
export interface ObserveSession {
  version: number;
  sessionId: string;
  tenantId: string;
  project: string;
  model: string;
  thinkingLevel: string;
  status: string;
  entryCount: number;
  lastEntrySeq: number;
  createdAt: string;
  updatedAt: string;
}

/** trace 时间线条目（F/WP4 Task 21） */
export interface ObserveTraceEntry {
  seq: number;
  id: string;
  parentId: string | null;
  role: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  createdAt: string;
  [key: string]: unknown;
}

export interface ObserveTrace {
  sessionId: string;
  tenantId: string;
  project: string;
  entries: ObserveTraceEntry[];
}

/** 观测事件条目（F/WP5 Task 28b——EventLog 结构子集，经常驻会话通道透传） */
export interface ObserveEventEntry {
  eventId: string;
  eventType: string;
  timestamp: number;
  sequence?: number;
  identity: { traceId: string };
  payload: unknown;
}

/** 观测事件查询结果（/api/v1/observe/events） */
export interface ObserveEventsResult {
  tenantId: string;
  count: number;
  events: ObserveEventEntry[];
}

/** fallback_requests 条目（F/WP4 Task 20） */
export interface FallbackRequestEntry {
  requestId: string;
  slotHint?: string;
  description: string;
  urgency: string;
  createdAt: string;
  status: "open" | "closed";
  closedBy?: string;
  closedAt?: string;
}

