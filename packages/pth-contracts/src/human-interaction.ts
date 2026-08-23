/**
 * contracts/human-interaction.ts — 通用人工交互领域模型（N25，不含 AgentEngine）。
 *
 * 用于 Human Review HTTP API 与任务挂起/恢复 gate：HumanRequest / HumanResponse /
 * ApprovalDecision / TaskSuspension / TaskWaitGate。
 * 本层只定义纯类型与结构校验；PG 事务、CAS 由 src/pth/interaction 实现。
 */

export type HumanRequestStatus = "pending" | "responded" | "cancelled" | "expired";
export type ApprovalDecision = "approved" | "rejected";

export interface HumanResponse {
  readonly requestId: string;
  readonly decision: ApprovalDecision;
  readonly reason?: string;
  /** 服务器端从 auth hook 盖章；body 不得自报 */
  readonly principalId: string;
  readonly respondedAt: string;
  /** 幂等键（可选；重复相同 response 幂等） */
  readonly idempotencyKey?: string;
}

export interface HumanRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly taskId: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  /** 可响应人（principalId 或 role selector）；空数组 = 任意已认证用户 */
  readonly assignedTo: readonly string[];
  readonly policySelector?: string;
  readonly status: HumanRequestStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly response?: HumanResponse;
}

export interface TaskWaitGate {
  readonly taskId: string;
  readonly requestId: string;
  readonly status: "waiting" | "resolved";
  readonly decision?: ApprovalDecision;
  readonly createdAt: string;
  readonly resolvedAt?: string;
}

/** 任务执行中产生的“等待人工/发布者”信号（runner 可返回，不消耗 claims budget）。 */
export type TaskSuspension =
  | {
      readonly kind: "human";
      readonly requestId: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "publisher-question";
      /** 子任务向发布者提出的自由文本问题（必填，非空） */
      readonly question: string;
      /** 提问时附带的上下文快照（可选） */
      readonly context?: Record<string, unknown>;
    };

/** 人工审核响应写入结果（CAS 后返回给 API 层）。 */
export interface HumanResponseResult {
  readonly requestId: string;
  readonly status: HumanRequestStatus;
  readonly decision: ApprovalDecision;
  readonly taskStatus: string;
  readonly committed: boolean;
}

// ── 结构校验（fail-closed；布尔风格） ───────────────────────────────

const HUMAN_REQUEST_STATUSES: readonly string[] = ["pending", "responded", "cancelled", "expired"];
const APPROVAL_DECISIONS: readonly string[] = ["approved", "rejected"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function isIsoDateString(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

export function isApprovalDecision(v: unknown): v is ApprovalDecision {
  return typeof v === "string" && APPROVAL_DECISIONS.includes(v);
}

export function isHumanResponseStructurallyValid(v: unknown): v is HumanResponse {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.requestId) || !isApprovalDecision(v.decision) || !isNonEmptyString(v.principalId)) return false;
  if (!isIsoDateString(v.respondedAt)) return false;
  if (v.reason !== undefined && typeof v.reason !== "string") return false;
  if (v.idempotencyKey !== undefined && !isNonEmptyString(v.idempotencyKey)) return false;
  return true;
}

export function isHumanRequestStructurallyValid(v: unknown): v is HumanRequest {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id) || !isNonEmptyString(v.tenantId) || !isNonEmptyString(v.taskId)) return false;
  if (!isNonEmptyString(v.kind) || !isNonEmptyString(v.title) || !isNonEmptyString(v.body)) return false;
  if (!Array.isArray(v.assignedTo) || !v.assignedTo.every((x) => typeof x === "string" && x.trim() !== "")) return false;
  if (v.policySelector !== undefined && !isNonEmptyString(v.policySelector)) return false;
  if (typeof v.status !== "string" || !HUMAN_REQUEST_STATUSES.includes(v.status)) return false;
  if (!isNonEmptyString(v.createdBy) || !isIsoDateString(v.createdAt)) return false;
  if (v.expiresAt !== undefined && !isIsoDateString(v.expiresAt)) return false;
  if (v.response !== undefined && !isHumanResponseStructurallyValid(v.response)) return false;
  return true;
}

export function isTaskWaitGateStructurallyValid(v: unknown): v is TaskWaitGate {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.taskId) || !isNonEmptyString(v.requestId)) return false;
  if (v.status !== "waiting" && v.status !== "resolved") return false;
  if (!isIsoDateString(v.createdAt)) return false;
  if (v.decision !== undefined && !isApprovalDecision(v.decision)) return false;
  if (v.resolvedAt !== undefined && !isIsoDateString(v.resolvedAt)) return false;
  return true;
}

export function isTaskSuspensionStructurallyValid(v: unknown): v is TaskSuspension {
  if (!isRecord(v)) return false;
  if (v.kind === "human") {
    if (!isNonEmptyString(v.requestId)) return false;
    if (v.reason !== undefined && typeof v.reason !== "string") return false;
    return true;
  }
  if (v.kind === "publisher-question") {
    if (!isNonEmptyString(v.question)) return false;
    if (v.context !== undefined && (!isRecord(v.context) || Array.isArray(v.context))) return false;
    return true;
  }
  return false;
}
