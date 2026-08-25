/**
 * contracts/tasking-types.ts — 任务认领/执行/提交的跨模块协议类型与常量。
 *
 * 从 `tasking.ts` 非破坏性拆分：类型/常量集中于此。
 */

import type { WorkerReplicaRef } from "./cognitive-responsibility.js";
import type { TenantScope, WorkspaceRef } from "./identity.js";
import type { DomainBinding, DomainId } from "./domains.js";
import type { WorkMode } from "./work-mode.js";
import type { TaskSuspension } from "./human-interaction.js";

export interface TaskLeaseReference {
  readonly taskId: string;
  readonly leaseId: string;
  readonly generation: number;
}

export interface TaskLease extends TaskLeaseReference {
  readonly scope: TenantScope;
  readonly workspace: WorkspaceRef;
  readonly roleId: string;
  /**
   * lease 到期时刻（服务端 `tasks.lease_expires_at` 的镜像）。
   * N29 P0-2：到期即失效——过期 lease 既不能提交 outcome，也不能因此写下一阶段 outbox；
   * 过期后只能被 `recoverExpired()` 回收并以更高 generation 重新 claim。
   */
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
  /** M0：服务端盖章的 Work Mode（tasks.work_mode）；reader 恒 stamp，legacy 缺省为 run。 */
  readonly workMode?: WorkMode;
}

export interface ArtifactRef {
  readonly kind: string;
  readonly uri: string;
  readonly mediaType?: string;
}

// ─── W8 P0：任务投递契约（docs/pth/design/w8-task-dispatch-design.md §3） ───────────
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
  /** 类型树派发路径（含自身类型），如 ["actuator","developer","coder"] */
  readonly path: readonly string[];
  /** 同一入口任务派生树的根 id（入口任务 = 自身 taskId） */
  readonly lineageId: string;
  /** 回流目标：父任务（默认）或穿透调用点 */
  readonly replyTo?: DeliveryReplyTo;
  /** 最终产物引用（done 声明产物时由服务端回写） */
  readonly artifactRef?: DeliveryArtifactRef;
  /**
   * 根目标（入口盖章，delegate 时服务端原样传播——不可转述、不可改写）。
   * 可选；legacy 任务无 goal 时 prompt 段省略，不 break。
   */
  readonly goal?: string;
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
  /** 子任务 paused 问题（notifier 写入；task-loop 盖章进上下文——tasks.resume/answer 读） */
  childQuestion?: Readonly<Record<string, TaskChildQuestion>>;
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

/** 子任务 paused 时上行的发布者问题（notifier 写入父任务 payload.childQuestion）。 */
export interface TaskChildQuestion {
  readonly question: string;
  readonly context?: Record<string, unknown>;
  readonly askedAt: string;
  readonly askedBy: string;
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
  /**
   * 续约当前 claim（CAS：lease_id + lease_generation + status='claimed'）。
   * 返回 renewed:false 表示认领已被回收/跨 generation——调用方应停止续约。
   */
  renewLease(
    ref: TaskLeaseReference,
    opts?: { ttlMs?: number },
  ): Promise<{ renewed: boolean; deadlineAt?: string }>;
  /** 回收过期 claimed 行；返回回收行数。只清 `lease_expires_at < now - graceMs` 的行且 generation 单调。 */
  recoverExpired(now: Date, graceMs?: number): Promise<number>;
  commit(outcome: TaskOutcome, opts?: TaskCommitOptions): Promise<{ committed: boolean }>;
}

// ─── N29 P0-1/P0-2：commit 的服务端 tenant scope 与同事务 side effect 契约 ────

export interface TaskCommitScope {
  readonly tenantId: string;
}

export interface TaskCommitSideEffect {
  readonly key: string;
  /** @deprecated 由仓库从通过 CAS 的 `tasks.tenant_id` 盖章；提供不相等值 → fail closed。 */
  readonly tenantId?: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface TaskCommitOptions {
  /** 服务端盖章 tenant scope（缺省时退回 outcome.lease 上的服务端 lease scope；两者皆无 → fail closed）。 */
  readonly scope?: TaskCommitScope;
  readonly sideEffects?: ReadonlyArray<TaskCommitSideEffect>;
}

/** 任务读模型端口（tasking adapter 提供；网关/查询侧只消费此窄接口） */
export interface TaskReadModel {
  pending(opts?: { roleId?: string; tenantId?: string; limit?: number; scope?: TenantScope }): Promise<readonly TaskWorkItem[]>;
  get(taskId: string, scope: TenantScope): Promise<TaskWorkItem | null>;
}

/** 执行结果：终态 TaskOutcome 或等待人工 TaskSuspension。 */
export type TaskRunResult = TaskOutcome | TaskSuspension;

/** 纯执行端口：只收 lease + work，产出 outcome，不调用 repository/audit/transcript/notify。 */
export interface TaskRunner {
  run(input: { lease: TaskLease; work: TaskWorkItem; signal?: AbortSignal }): Promise<TaskRunResult>;
}

/** 单任务最大认领次数（坏任务兜底——tasking 与 storage 共用同一策略常量） */
export const TASK_MAX_CLAIMS = 10;

/** payload 中 TaskDelivery 的存储键（用户裁决 Q1：单键包裹） */
export const TASK_DELIVERY_PAYLOAD_KEY = "delivery";
/** payload.result 的 64KiB 上限（用户裁决 Q3 方案 1） */
export const TASK_RESULT_MAX_BYTES = 64 * 1024;

export interface EncodedTaskResult {
  /** JSON-safe 值（可直接 jsonb 写入） */
  value: unknown;
  truncated: boolean;
  unserializable: boolean;
}

export interface TaskResultWriteback {
  /** payload.result 要写入的值（completed=结果；rejected/cancelled=错误摘要） */
  result: unknown;
  /** 仅 completed 且 done 声明合法产物时非 null */
  artifactRef: DeliveryArtifactRef | null;
}
