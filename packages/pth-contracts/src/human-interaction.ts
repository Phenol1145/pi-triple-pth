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

// ── N25 完整协议：Intent / TaskDraft / Quality Gate（契约层先行） ──────

export type IntentMode = "chitchat" | "discussion" | "request";

export interface IntentProposal {
  readonly mode: IntentMode;
  readonly title?: string;
  readonly text?: string;
  readonly confidence: number;
  readonly reason?: string;
}

export interface TaskDraft {
  readonly id: string;
  readonly revision: number;
  readonly tenantId: string;
  readonly principalId: string;
  readonly title: string;
  readonly text: string;
  readonly status: "draft" | "quality-gate" | "submitted";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contentHash: string;
}

export interface TaskDraftSubmission {
  readonly draftId: string;
  readonly revision: number;
  readonly submittedAt: string;
}

export interface QualityGateResult {
  readonly pass: boolean;
  readonly checks: readonly string[];
  readonly failures: readonly string[];
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

const INTENT_MODES: readonly string[] = ["chitchat", "discussion", "request"];

export function isIntentProposalStructurallyValid(v: unknown): v is IntentProposal {
  if (!isRecord(v)) return false;
  if (typeof v.mode !== "string" || !INTENT_MODES.includes(v.mode)) return false;
  if (typeof v.confidence !== "number" || v.confidence < 0 || v.confidence > 1) return false;
  if (v.title !== undefined && !isNonEmptyString(v.title)) return false;
  if (v.text !== undefined && !isNonEmptyString(v.text)) return false;
  if (v.reason !== undefined && typeof v.reason !== "string") return false;
  return true;
}

export function isTaskDraftStructurallyValid(v: unknown): v is TaskDraft {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id) || !isNonEmptyString(v.tenantId) || !isNonEmptyString(v.principalId)) return false;
  if (!isNonEmptyString(v.title) || !isNonEmptyString(v.text)) return false;
  if (typeof v.revision !== "number" || !Number.isInteger(v.revision) || v.revision < 1) return false;
  if (v.status !== "draft" && v.status !== "quality-gate" && v.status !== "submitted") return false;
  if (!isIsoDateString(v.createdAt) || !isIsoDateString(v.updatedAt)) return false;
  if (!isNonEmptyString(v.contentHash)) return false;
  return true;
}

export function isTaskDraftSubmissionStructurallyValid(v: unknown): v is TaskDraftSubmission {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.draftId) || typeof v.revision !== "number" || !Number.isInteger(v.revision) || v.revision < 1) return false;
  if (!isIsoDateString(v.submittedAt)) return false;
  return true;
}

export function isQualityGateResultStructurallyValid(v: unknown): v is QualityGateResult {
  if (!isRecord(v)) return false;
  if (typeof v.pass !== "boolean" || !Array.isArray(v.checks) || !Array.isArray(v.failures)) return false;
  if (!v.checks.every((x) => typeof x === "string") || !v.failures.every((x) => typeof x === "string")) return false;
  return true;
}
