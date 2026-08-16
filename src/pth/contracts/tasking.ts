/**
 * contracts/tasking.ts — 任务认领/执行/提交的跨模块协议（纯类型 + 结构校验）。
 *
 * TaskLease 是 capability，不是可预测字符串；generation 单调、deadline 到期即失效。
 * 本层只校验结构形状；UUID 签发、持久化 lease 状态与 CAS 语义由 tasking adapter 实现。
 */

import {
  isTenantScopeStructurallyValid,
  isUuidLike,
  isWorkspaceRefStructurallyValid,
  type TenantScope,
  type WorkspaceRef,
} from "./identity.js";

export interface TaskLeaseReference {
  readonly taskId: string;
  readonly leaseId: string;
  readonly generation: number;
}

export interface TaskLease extends TaskLeaseReference {
  readonly scope: TenantScope;
  readonly workspace: WorkspaceRef;
  readonly roleId: string;
  readonly deadlineAt: string;
}

export interface TaskWorkItem {
  readonly taskId: string;
  readonly scope: TenantScope;
  readonly title: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly payload: unknown;
  readonly assignedRole: string;
}

export interface ArtifactRef {
  readonly kind: string;
  readonly uri: string;
  readonly mediaType?: string;
}

export type TaskOutcomeStatus = "completed" | "rejected" | "cancelled";

export interface TaskOutcome {
  readonly lease: TaskLeaseReference;
  readonly status: TaskOutcomeStatus;
  /** rejected 且 retryable=true 时，提交方可以把任务释放回队列 */
  readonly retryable?: boolean;
  readonly result?: unknown;
  readonly error?: { code: string; message: string };
  readonly artifacts: readonly ArtifactRef[];
  readonly usage?: Readonly<Record<string, number>>;
  readonly traceId: string;
}

/** 任务持久化端口（adapter = pg-task-repository；具体 pg 类型不得越过此边界） */
export interface TaskRepository {
  claim(
    scope: TenantScope,
    roleId: string,
    taskIds: readonly string[],
  ): Promise<ReadonlyArray<{ lease: TaskLease; work: TaskWorkItem }>>;
  /** 回收过期 claimed 行；返回回收行数。只清过期行且 generation 单调。 */
  recoverExpired(now: Date): Promise<number>;
  /** CAS 提交：重复/过期/跨租户 outcome 一律 committed=false。 */
  commit(outcome: TaskOutcome): Promise<{ committed: boolean }>;
}

/** 任务读模型端口（tasking adapter 提供；网关/查询侧只消费此窄接口） */
export interface TaskReadModel {
  pending(opts?: { roleId?: string; tenantId?: string; limit?: number }): Promise<readonly TaskWorkItem[]>;
  get(taskId: string, scope: TenantScope): Promise<TaskWorkItem | null>;
}

/** 纯执行端口：只收 lease + work，产出 outcome，不调用 repository/audit/transcript/notify。 */
export interface TaskRunner {
  run(input: { lease: TaskLease; work: TaskWorkItem; signal?: AbortSignal }): Promise<TaskOutcome>;
}

const STATUSES: readonly TaskOutcomeStatus[] = ["completed", "rejected", "cancelled"];
const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function isTaskLeaseReferenceStructurallyValid(v: unknown): v is TaskLeaseReference {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  return (
    NON_EMPTY_STRING(l.taskId) &&
    isUuidLike(l.leaseId) &&
    typeof l.generation === "number" &&
    Number.isInteger(l.generation) &&
    l.generation > 0
  );
}

export function isTaskLeaseStructurallyValid(v: unknown): v is TaskLease {
  if (!isTaskLeaseReferenceStructurallyValid(v)) return false;
  const l = v as unknown as Record<string, unknown>;
  return (
    isTenantScopeStructurallyValid(l.scope) &&
    isWorkspaceRefStructurallyValid(l.workspace) &&
    NON_EMPTY_STRING(l.roleId) &&
    typeof l.deadlineAt === "string" &&
    Number.isFinite(Date.parse(l.deadlineAt))
  );
}

export function isTaskWorkItemStructurallyValid(v: unknown): v is TaskWorkItem {
  if (typeof v !== "object" || v === null) return false;
  const w = v as Record<string, unknown>;
  return (
    NON_EMPTY_STRING(w.taskId) &&
    isTenantScopeStructurallyValid(w.scope) &&
    typeof w.title === "string" &&
    typeof w.text === "string" &&
    Array.isArray(w.tags) &&
    w.tags.every((t) => NON_EMPTY_STRING(t)) &&
    NON_EMPTY_STRING(w.assignedRole)
  );
}

export function isArtifactRefStructurallyValid(v: unknown): v is { kind: string; uri: string; mediaType?: string } {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  if (!NON_EMPTY_STRING(a.kind) || !NON_EMPTY_STRING(a.uri)) return false;
  if (a.mediaType !== undefined && typeof a.mediaType !== "string") return false;
  return true;
}

export function isTaskOutcomeStructurallyValid(v: unknown): v is TaskOutcome {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!isTaskLeaseReferenceStructurallyValid(o.lease)) return false;
  if (!STATUSES.includes(o.status as TaskOutcomeStatus)) return false;
  if (o.retryable !== undefined && typeof o.retryable !== "boolean") return false;
  if (!Array.isArray(o.artifacts) || !o.artifacts.every(isArtifactRefStructurallyValid)) return false;
  if (o.error !== undefined) {
    const e = o.error as Record<string, unknown>;
    if (typeof e !== "object" || e === null || !NON_EMPTY_STRING(e.code) || typeof e.message !== "string") return false;
  }
  if (o.usage !== undefined && (typeof o.usage !== "object" || o.usage === null || Object.values(o.usage).some((n) => typeof n !== "number" || !Number.isFinite(n)))) return false;
  if (!NON_EMPTY_STRING(o.traceId)) return false;
  return true;
}
