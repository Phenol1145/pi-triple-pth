/**
 * contracts/tasking.ts — 任务认领/执行/提交的跨模块协议（纯类型 + 结构校验）。
 *
 * TaskLease 是 capability，不是可预测字符串；generation 单调、deadline 到期即失效。
 * 本层只校验结构形状；UUID 签发、持久化 lease 状态与 CAS 语义由 tasking adapter 实现。
 */

import { Buffer } from "node:buffer";
import type { WorkerReplicaRef } from "./cognitive-responsibility.js";
import {
  isTenantScopeStructurallyValid,
  isUuidLike,
  isWorkspaceRefStructurallyValid,
  type TenantScope,
  type WorkspaceRef,
} from "./identity.js";
import {
  validateDomainBinding,
  type DomainBinding,
  type DomainId,
} from "./domains.js";

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
  /** 学科识别结果（可为空；确定性排序）——K2 Phase 2 */
  readonly domains: readonly DomainId[];
  /** 解析证据（机读盖章；服务器 resolver 产物） */
  readonly domainBinding?: DomainBinding;
}

export interface ArtifactRef {
  readonly kind: string;
  readonly uri: string;
  readonly mediaType?: string;
}

// ─── W8 P0：任务投递契约（docs/pth/w8-task-dispatch-design.md §3） ───────────
// TaskDelivery 存在任务 payload 的 `delivery` 单键下（用户裁决 Q1）；
// parent/path/lineageId 只能由服务器端盖章，worker/外部 body 不可自报。

export const DELIVERY_ARTIFACT_KINDS = ["memory", "file", "component"] as const;
export type DeliveryArtifactKind = (typeof DELIVERY_ARTIFACT_KINDS)[number];
export type DeliveryReplyTo = "parent" | "caller";

export interface DeliveryArtifactRef {
  readonly kind: DeliveryArtifactKind;
  /** memory=entry id；file/component=uri 或引用 id */
  readonly id: string;
}

export interface TaskDeliveryParent {
  readonly taskId: string;
  readonly roleId: string;
  /** 父任务在类型树上的派发路径 */
  readonly typePath: readonly string[];
}

export interface TaskDelivery {
  /** 外部入口任务不设置；worker delegate 时由服务端按调用者身份盖章 */
  readonly parent?: TaskDeliveryParent;
  /** 类型树派发路径（含自身类型），如 ["origin","developer","coder"] */
  readonly path: readonly string[];
  /** 同一入口任务派生树的根 id（入口任务 = 自身 taskId） */
  readonly lineageId: string;
  /** 回流目标：父任务（默认）或穿透调用点 */
  readonly replyTo?: DeliveryReplyTo;
  /** 最终产物引用（done 声明产物时由服务端回写） */
  readonly artifactRef?: DeliveryArtifactRef;
}

// ─── W8 P1：tasks.delegate / tasks.await 工具契约（服务端只认本形状） ───────

export interface TaskDelegateInput {
  /** 必填；白名单 = 直接子类型（组织权矩阵 + planner/governor 补充权） */
  to: string;
  title: string;
  /** 自包含任务描述（T01/T03/T04 教训） */
  text: string;
  template?: string;
  params?: Record<string, unknown>;
  tags?: string[];
  /** F3：显式 domain 子集收窄（必须 ⊆ caller.domains，否则 fail-fast） */
  domains?: string[];
  /** 父方整理好的上下文快照（压缩后随任务传递） */
  context?: Record<string, unknown>;
  /** 回流预期：决定 await 返回内容（P2 按此裁剪） */
  expect?: "result" | "artifact" | "report";
}

export interface TaskDelegateResult {
  taskId: string;
  roleId: string;
  /** 子任务的派发路径（含自身类型） */
  path: readonly string[];
}

/** 当前执行中任务的服务器侧身份（task-loop 每任务盖章，worker 不可自报） */
export interface TaskDispatchContext {
  taskId: string;
  roleId: string;
  tenantId: string;
  /** Runtime replica identity stamped by batch TaskLoop; absent only on legacy/test callers. */
  worker?: WorkerReplicaRef;
  /** 当前任务 payload.delivery（无章的 legacy/内部任务为 null → 服务端按 root 兜底） */
  delivery: TaskDelivery | null;
  /** F3：当前任务 payload.domains（task-work-item-reader 解析；legacy 无章 → []） */
  domains?: readonly DomainId[];
  /** F3：当前任务 payload.domainBinding（结构合法才存在；task-work-item-reader 解析） */
  domainBinding?: DomainBinding;
  /** 当前任务登记中的等待子任务（await 挂起时服务端写入；task-loop 盖章进上下文） */
  dispatchWait?: Readonly<Record<string, { at: string }>>;
  /** 子任务终态回流结果（notifier 写入；task-loop 盖章进上下文——tasks.resume 读） */
  childResult?: Readonly<Record<string, TaskAwaitResult>>;
}

/** tasks.await 挂起信号错误码（interpreter error.code 透传；runner 据此落 retryable requeue） */
export const TASK_AWAIT_SUSPENDED_CODE = "task-await-suspended";

export interface TaskCancelResult {
  cancelled: number;
  taskIds: string[];
}

export interface TaskAwaitInput {
  taskId: string;
  timeoutMs?: number;
  /** P2 支持放弃等待（父先失败或改异步）；P1 只落契约不做挂起 */
  detach?: boolean;
}

export interface TaskAwaitResult {
  status: string;
  /** 未终态（P1 一次性查询形态）：true——P2 会换成挂起 + requeue 语义 */
  waiting?: boolean;
  result?: unknown;
  artifactRef?: DeliveryArtifactRef | null;
  summary?: string;
  error?: { code: string; message: string };
}

/** 0.16.3 穿透调用输入（显式原语 tasks.penetrate——已注册穿透边才可用） */
export interface TaskPenetrateInput {
  /** 被穿透调用的直接子类型（必须已注册 skill:penetrate:<to> 且边 parent = 调用方） */
  to: string;
  title: string;
  /** 自包含子任务描述（按穿透 skill 的输入契约组织） */
  text: string;
  /** 附加上下文快照（可选——随任务文本传给子 agent） */
  context?: Record<string, unknown>;
}

export interface TaskPenetrateResult {
  ok: true;
  /** 子 agent done.result（产物契约 v1 文档级——不做机器形状校验，用户裁决 P4） */
  value: unknown;
  summary?: string;
  /** 子 agent 步数（计入父任务计量面——预算经济化后续细化） */
  steps: number;
  childRole: string;
  durationMs: number;
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
  pending(opts?: { roleId?: string; tenantId?: string; limit?: number; scope?: TenantScope }): Promise<readonly TaskWorkItem[]>;
  get(taskId: string, scope: TenantScope): Promise<TaskWorkItem | null>;
}

/** 纯执行端口：只收 lease + work，产出 outcome，不调用 repository/audit/transcript/notify。 */
export interface TaskRunner {
  run(input: { lease: TaskLease; work: TaskWorkItem; signal?: AbortSignal }): Promise<TaskOutcome>;
}

/** 单任务最大认领次数（坏任务兜底——tasking 与 storage 共用同一策略常量） */
export const TASK_MAX_CLAIMS = 10;

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
  const domainsOk = Array.isArray(w.domains) && w.domains.every((d) => NON_EMPTY_STRING(d));
  return (
    NON_EMPTY_STRING(w.taskId) &&
    isTenantScopeStructurallyValid(w.scope) &&
    typeof w.title === "string" &&
    typeof w.text === "string" &&
    Array.isArray(w.tags) &&
    w.tags.every((t) => NON_EMPTY_STRING(t)) &&
    NON_EMPTY_STRING(w.assignedRole) &&
    domainsOk &&
    (w.domainBinding === undefined ||
      (domainsOk && validateDomainBinding(w.domainBinding as DomainBinding, new Set(w.domains as readonly string[])).ok))
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

// ─── W8 P0：TaskDelivery 结构校验与服务器端盖章/回写（纯函数） ───────────

function isNonEmptyStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.length > 0 && v.every(NON_EMPTY_STRING);
}

export function isDeliveryArtifactRefStructurallyValid(v: unknown): v is DeliveryArtifactRef {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    DELIVERY_ARTIFACT_KINDS.includes(a.kind as DeliveryArtifactKind) &&
    NON_EMPTY_STRING(a.id)
  );
}

export function isTaskDeliveryStructurallyValid(v: unknown): v is TaskDelivery {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  if (!isNonEmptyStringArray(d.path) || !NON_EMPTY_STRING(d.lineageId)) return false;
  if (d.parent !== undefined) {
    const p = d.parent as Record<string, unknown>;
    if (
      typeof p !== "object" || p === null ||
      !NON_EMPTY_STRING(p.taskId) || !NON_EMPTY_STRING(p.roleId) ||
      !isNonEmptyStringArray(p.typePath)
    ) return false;
  }
  if (d.replyTo !== undefined && d.replyTo !== "parent" && d.replyTo !== "caller") return false;
  if (d.artifactRef !== undefined && !isDeliveryArtifactRefStructurallyValid(d.artifactRef)) return false;
  return true;
}

/** payload 中 TaskDelivery 的存储键（用户裁决 Q1：单键包裹） */
export const TASK_DELIVERY_PAYLOAD_KEY = "delivery";
/** payload.result 的 64KiB 上限（用户裁决 Q3 方案 1） */
export const TASK_RESULT_MAX_BYTES = 64 * 1024;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * 服务器端入口盖章：path=[assignedRole]、lineageId=自身 taskId、不设 parent。
 * 仅当 taskId 与 assignedRole 均有效时返回；否则返回 null（调用方决定拒绝或降级）。
 */
export function buildEntryDelivery(taskId: string, roleId: string): TaskDelivery | null {
  if (!NON_EMPTY_STRING(taskId) || !NON_EMPTY_STRING(roleId)) return null;
  return { path: [roleId], lineageId: taskId };
}

/** 把入口 delivery 合入 payload 的 `delivery` 键；payload 非普通对象时先归一化为对象。 */
export function attachEntryDelivery(payload: unknown, taskId: string, roleId: string): Record<string, unknown> {
  const base = isPlainRecord(payload) ? { ...payload } : {};
  const delivery = buildEntryDelivery(taskId, roleId);
  if (delivery) base[TASK_DELIVERY_PAYLOAD_KEY] = delivery;
  return base;
}

export interface EncodedTaskResult {
  /** JSON-safe 值（可直接 jsonb 写入） */
  value: unknown;
  truncated: boolean;
  unserializable: boolean;
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function jsonBytes(v: unknown): number | undefined {
  try {
    return utf8Bytes(JSON.stringify(v));
  } catch {
    return undefined;
  }
}

function buildUnserializableFallback(v: unknown): Record<string, unknown> {
  return {
    __pthUnserializable: true,
    type: typeof v,
    preview: String(v).slice(0, 2000),
  };
}

const CLIP_MARKER = "…（已截断）";

function clipStringValue(s: string, budget: number): string {
  const whole = utf8Bytes(JSON.stringify(s));
  if (whole <= budget) return s;
  // 二分找最大前缀：prefix + 截断标记 序列化后仍 ≤ budget
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(JSON.stringify(s.slice(0, mid) + CLIP_MARKER)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + CLIP_MARKER;
}

interface ClippedValue {
  value: unknown;
  unserializable: boolean;
  /** 本值或其任意后代被截断（不一定有空间追加 __pthTruncated 标记） */
  truncated: boolean;
}

function clipJsonValue(v: unknown, budget: number): ClippedValue {
  if (typeof v === "string") {
    const whole = utf8Bytes(JSON.stringify(v));
    return whole <= budget
      ? { value: v, unserializable: false, truncated: false }
      : { value: clipStringValue(v, budget), unserializable: false, truncated: true };
  }
  if (v === null || typeof v === "boolean" || typeof v === "number") {
    return (jsonBytes(v) ?? Infinity) <= budget
      ? { value: v, unserializable: false, truncated: false }
      : { value: null, unserializable: false, truncated: false };
  }
  if (typeof v === "undefined" || typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
    return { value: `[unserializable:${typeof v}]`, unserializable: true, truncated: false };
  }
  if (Array.isArray(v)) return clipArrayValue(v, budget);
  if (isPlainRecord(v)) return clipRecordValue(v, budget);
  // Date/Map/Set/类实例等非普通对象：JSON.stringify 会静默丢字段——降级为摘要字符串
  return { value: String(v).slice(0, 2000), unserializable: false, truncated: false };
}

/** 截断标记对象（末位追加；预算不足时不追加，但 truncated 语义仍由调用方判断） */
function clipArrayValue(arr: readonly unknown[], budget: number): ClippedValue {
  const out: unknown[] = [];
  let used = 2; // []
  let unserializable = false;
  let truncated = false;
  let omitted = 0;
  for (const item of arr) {
    const remaining = budget - used;
    if (remaining <= 0) { omitted++; continue; }
    const clipped = clipJsonValue(item, remaining);
    const candidate = [...out, clipped.value];
    const candidateBytes = jsonBytes(candidate);
    if (candidateBytes === undefined || candidateBytes > budget) { omitted++; continue; }
    out.push(clipped.value);
    used = candidateBytes;
    unserializable ||= clipped.unserializable;
    truncated ||= clipped.truncated;
  }
  if (omitted > 0 || truncated) {
    const marker = { __pthTruncated: true, ...(omitted > 0 ? { omittedItems: omitted } : {}) };
    const withMarker = [...out, marker];
    if ((jsonBytes(withMarker) ?? Infinity) <= budget) out.push(marker);
  }
  return { value: out, unserializable, truncated: truncated || omitted > 0 };
}

function clipRecordValue(rec: Record<string, unknown>, budget: number): ClippedValue {
  const out: Record<string, unknown> = {};
  let used = 2; // {}
  let unserializable = false;
  let truncated = false;
  let omitted = 0;
  for (const [key, item] of Object.entries(rec)) {
    const keyBytes = jsonBytes(key) ?? 16;
    const remaining = budget - used - keyBytes;
    if (remaining <= 0) { omitted++; continue; }
    const clipped = clipJsonValue(item, remaining);
    const candidate = { ...out, [key]: clipped.value };
    const candidateBytes = jsonBytes(candidate);
    if (candidateBytes === undefined || candidateBytes > budget) { omitted++; continue; }
    out[key] = clipped.value;
    used = candidateBytes;
    unserializable ||= clipped.unserializable;
    truncated ||= clipped.truncated;
  }
  if (omitted > 0 || truncated) {
    const truncatedMarker = { ...out, __pthTruncated: true };
    if ((jsonBytes(truncatedMarker) ?? Infinity) <= budget) out.__pthTruncated = true;
    if (omitted > 0) {
      const countedMarker = { ...out, __pthOmittedKeys: omitted };
      if ((jsonBytes(countedMarker) ?? Infinity) <= budget) out.__pthOmittedKeys = omitted;
    }
  }
  return { value: out, unserializable, truncated: truncated || omitted > 0 };
}

/**
 * done.result → payload.result 编码（用户裁决 Q3 方案 1）：
 *  - 可 JSON 序列化且 ≤64KiB：原值 round-trip（结构保留）；
 *  - 超限：递归截断容器/字符串并带 __pthTruncated 标记；
 *  - 不可序列化（循环引用/函数/BigInt 根值等）：降级为错误摘要对象，不抛错。
 */
export function encodeResultForPayload(input: unknown, maxBytes: number = TASK_RESULT_MAX_BYTES): EncodedTaskResult {
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    json = undefined;
  }
  if (json !== undefined) {
    const bytes = utf8Bytes(json);
    if (bytes <= maxBytes) {
      return { value: JSON.parse(json) as unknown, truncated: false, unserializable: false };
    }
    const clipped = clipJsonValue(input, maxBytes);
    return { value: clipped.value, truncated: true, unserializable: clipped.unserializable };
  }
  // JSON.stringify 返回 undefined 且不抛错：root 为 undefined/function/symbol
  return { value: buildUnserializableFallback(input), truncated: false, unserializable: true };
}

/** 把 runner ArtifactRef 映射为 TaskDelivery.artifactRef（kind 必须在 memory/file/component 白名单内） */
export function toDeliveryArtifactRef(ref: ArtifactRef | undefined): DeliveryArtifactRef | null {
  if (!ref || !isArtifactRefStructurallyValid(ref)) return null;
  if (!DELIVERY_ARTIFACT_KINDS.includes(ref.kind as DeliveryArtifactKind)) return null;
  return { kind: ref.kind as DeliveryArtifactKind, id: ref.uri };
}

export interface TaskResultWriteback {
  /** payload.result 要写入的值（completed=结果；rejected/cancelled=错误摘要） */
  result: unknown;
  /** 仅 completed 且 done 声明合法产物时非 null */
  artifactRef: DeliveryArtifactRef | null;
}

export function buildCompletedResultWriteback(
  result: unknown,
  artifacts: readonly ArtifactRef[],
  maxBytes: number = TASK_RESULT_MAX_BYTES,
): TaskResultWriteback {
  const encoded = encodeResultForPayload(result, maxBytes);
  return { result: encoded.value, artifactRef: toDeliveryArtifactRef(artifacts[0]) };
}

export function buildErrorResultWriteback(
  error: { code: string; message: string } | undefined,
  defaultMessage = "任务被拒绝",
): TaskResultWriteback {
  return {
    result: { error: error ?? { code: "rejected", message: defaultMessage } },
    artifactRef: null,
  };
}
