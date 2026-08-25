/**
 * tasking/task-control-service.ts — 任务控制服务（模块化 v2 P1-3）。
 *
 * publish 的 createdBy/tenantId 只从服务器端 TenantScope 派生；body 自报字段不可覆盖。
 * list/get 按 scope.tenantId 过滤（跨租户 get 返回 null、list 为空——路由 JSON 形状不变）。
 * W8 P1：delegate/awaitTask 是父→子投递原语的服务器侧唯一入口——组织权矩阵 + 盖章 + 标签校验。
 */

import type pg from "pg";
import type { Task, TaskStore } from "@away_from/pth-kernel-storage";
import type { PublishInput } from "@away_from/pth-kernel-storage";
import { withTx } from "@away_from/pth-kernel-storage";
import {
  buildEntryDelivery,
  canonicalDelegateSpecDigest,
  isSubmissionKeyValid,
  isTaskDeliveryStructurallyValid,
  isWorkMode,
  TASK_AWAIT_SUSPENDED_CODE,
  type ChildOutcomeEnvelopeV1,
  type ChildTaskRefV1,
  type PublisherQuestionEnvelopeV1,
  type TaskAwaitInput,
  type TaskAwaitResult,
  type TaskCancelResult,
  type TaskDelegateInput,
  type TaskDelegateResult,
  type TaskDelivery,
  type TaskDispatchContext,
  type TaskLease,
  type TaskSuspension,
  type TaskWorkItem,
  type TenantScope,
  type WorkMode,
} from "@away_from/pth-contracts";
import type { DomainBinding } from "@away_from/pth-contracts";
import { PgTaskQueries } from "./task-queries.js";
import {
  observeAdmissionRejected,
  observeDependencyStatus,
  observeSubmissionConflict,
  observeTaskSubmission,
} from "./task-dependency-metrics.js";
import { allowedDelegationTargets } from "./delegation-policy.js";
import { tagRegistry } from "@away_from/pth-kernel-execution";
import { resolveTemplateTask } from "@away_from/pth-kernel-interpreter";
import { PtcContractError } from "@away_from/pth-kernel-interpreter";
import { pthConfig } from "@away_from/pth-config";

export interface TaskControlServiceDeps {
  store: Pick<TaskStore, "publish" | "publishInTx">;
  pool: pg.Pool;
  queries: PgTaskQueries;
}

const DELEGATE_EXPECTATIONS = new Set(["result", "artifact", "report"]);

function delegateExpectation(v: unknown): v is TaskDelegateInput["expect"] {
  return v === undefined || DELEGATE_EXPECTATIONS.has(v as string);
}

function resultSummary(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as { summary?: unknown; value?: { summary?: unknown } };
  const s = r.summary ?? r.value?.summary;
  return typeof s === "string" && s !== "" ? s : undefined;
}

const CHILD_STATE_BY_TASK_STATUS: Record<string, ChildTaskRefV1["state"]> = {
  pending: "submitted",
  submitted: "submitted",
  claimed: "running",
  paused: "paused",
  "waiting-human": "paused",
  completed: "terminal",
  rejected: "terminal",
  escalated: "terminal",
  cancelled: "terminal",
  "waiting_dependency": "submitted",
};

function childStateFromTaskStatus(status: string | null | undefined): ChildTaskRefV1["state"] {
  if (!status) return "submitted";
  return CHILD_STATE_BY_TASK_STATUS[status] ?? "submitted";
}

function childQuestionFromPayload(childTaskId: string, payload: unknown): PublisherQuestionEnvelopeV1 | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as { pauseQuestion?: { question?: unknown } };
  const q = p.pauseQuestion?.question;
  if (typeof q !== "string" || q.trim() === "") return undefined;
  return { questionId: childTaskId, prompt: q, childTaskId };
}

function delegateResultFromRow(input: {
  taskId: string;
  submissionKey: string;
  roleId: string;
  path: readonly string[];
  childStatus?: string | null;
  childPayload?: unknown;
  outcomeEnvelope?: unknown;
  artifactRef?: unknown;
}): TaskDelegateResult {
  const observation = childObservationFromDependency({
    outcome_envelope: input.outcomeEnvelope,
    child_status: input.childStatus ?? undefined,
    payload: input.childPayload,
    artifact_ref: input.artifactRef,
  });
  const question = childQuestionFromPayload(input.taskId, input.childPayload);
  return {
    taskId: input.taskId,
    roleId: input.roleId,
    path: input.path,
    submissionKey: input.submissionKey,
    state: childStateFromTaskStatus(input.childStatus),
    ...(observation ? { observation } : {}),
    ...(question ? { question } : {}),
  };
}

function childObservationFromDependency(row: { outcome_envelope?: unknown; child_status?: string; payload?: unknown; artifact_ref?: unknown }): ChildOutcomeEnvelopeV1 | undefined {
  if (row.outcome_envelope && typeof row.outcome_envelope === "object") {
    return row.outcome_envelope as ChildOutcomeEnvelopeV1;
  }
  const status = row.child_status;
  if (!status || !["completed", "rejected", "escalated"].includes(status)) return undefined;
  const payload = row.payload ?? {};
  const result = (payload as { result?: unknown }).result ?? null;
  const errorObj = (result as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const artifactRef = row.artifact_ref as { id?: unknown } | null | undefined;
  return {
    status: status === "completed" ? "completed" : status === "escalated" ? "escalated" : (errorObj?.code === "cancelled" ? "cancelled" : "rejected"),
    summary: resultSummary(result) ?? "",
    provenance: [],
    artifactRefs: artifactRef && typeof artifactRef.id === "string" ? [artifactRef.id] : [],
    ...(errorObj && typeof errorObj.code === "string" && typeof errorObj.message === "string"
      ? { error: { family: errorObj.code, message: errorObj.message, retryable: false as const } }
      : {}),
  };
}

/**
 * W8 P2：tasks.await 挂起信号（事件驱动 requeue 的触发端）。
 * interpreter 会把 error.code 透传（InterpreterResult.error.code）——runner/agent-loop
 * 据此把父任务落成 retryable rejected（释放认领回 pending），等子任务终态事件唤醒。
 */
export class TaskAwaitSuspendedError extends PtcContractError {
  readonly code = TASK_AWAIT_SUSPENDED_CODE;
  readonly childTaskId: string;
  constructor(childTaskId: string, reason: string) {
    super("tasks.await", reason);
    this.childTaskId = childTaskId;
  }
}

export class TaskControlService {
  constructor(private deps: TaskControlServiceDeps) {}

  async publish(
    input: Omit<PublishInput, "createdBy" | "tenantId"> & { createdBy?: string; tenantId?: string },
    scope: TenantScope,
  ): Promise<Task> {
    // P1-3：服务器端盖章——body 里的 createdBy/tenantId 一律丢弃。
    // M0：gateway/用户发布恒为 run——body 里的 workMode 一律丢弃，不可自报 intake/optimize。
    // W8 P0：外部入口恒盖 entry delivery（path=[assignedRole]、lineageId=taskId）。
    const { createdBy: _createdBy, tenantId: _tenantId, workMode: _workMode, ...rest } = input;
    return this.deps.store.publish({
      ...rest,
      createdBy: scope.principalId,
      tenantId: scope.tenantId,
      workMode: "run",
      deliveryMode: "entry",
    });
  }

  /**
   * W8 P1：tasks.delegate 服务端实现（调用即拒绝——D3）。
   * 组织权矩阵在进入任务池前校验；parent/path/lineageId 全部由调用者身份盖章，
   * body 只允许任务内容/模板/标签/上下文/回流预期。
   */
  /**
   * M0：delegate 继承父任务的 tasks.work_mode。父行缺失（legacy/测试 caller 未落库）时
   * 不阻断既有 delegate 行为，按默认 run 继承；父行存在但值非法也 fail-closed 回 run。
   */
  private async resolveParentWorkMode(caller: TaskDispatchContext, scope: TenantScope): Promise<WorkMode> {
    try {
      const res = await this.deps.pool.query(
        `SELECT work_mode FROM tasks WHERE id = $1 AND tenant_id = $2`,
        [caller.taskId, scope.tenantId],
      );
      const row = res.rows[0] as { work_mode?: unknown } | undefined;
      return isWorkMode(row?.work_mode) ? row.work_mode : "run";
    } catch {
      return "run";
    }
  }

  async delegate(input: TaskDelegateInput, caller: TaskDispatchContext, scope: TenantScope): Promise<TaskDelegateResult> {
    const to = typeof input.to === "string" ? input.to.trim() : "";
    if (!to) throw new PtcContractError("tasks.delegate", "to 必填（直接子类型 id）");
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!title || !text) throw new PtcContractError("tasks.delegate", "title/text 必须是非空字符串（自包含任务描述）");
    if (!delegateExpectation(input.expect)) {
      throw new PtcContractError("tasks.delegate", "expect 仅支持 result/artifact/report");
    }
    if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((t) => typeof t !== "string" || t.trim() === ""))) {
      throw new PtcContractError("tasks.delegate", "tags 可选——若提供必须是字符串数组");
    }
    if (input.submissionKey !== undefined && !isSubmissionKeyValid(input.submissionKey)) {
      throw new PtcContractError("tasks.delegate", "submissionKey 可选——若提供必须是 1..128 字符且仅含 [A-Za-z0-9:_@.-]");
    }
    if (input.dependency !== undefined && input.dependency !== "required") {
      throw new PtcContractError("tasks.delegate", "dependency 仅支持 required（V1 不开放 detached）");
    }

    // F3：domains 显式子集收窄。body 的 domains 仅用于子集校验（不可自报最终 payload）；
    // 缺省完整继承 caller.domains/domainBinding，子 payload 由调用者封套派生。
    const callerDomains = caller.domains ?? [];
    const explicitSubset = input.domains !== undefined;
    let childDomains: readonly string[];
    if (input.domains !== undefined) {
      if (!Array.isArray(input.domains) || input.domains.some((d) => typeof d !== "string" || d.trim() === "")) {
        throw new PtcContractError("tasks.delegate", "domains 可选——若提供必须是字符串数组且元素非空");
      }
      const requested = [...new Set(input.domains.map((d) => d.trim()))];
      if (requested.length === 0) {
        throw new PtcContractError("tasks.delegate", "domains 子集不能为空");
      }
      const callerSet = new Set(callerDomains);
      const overreach = requested.filter((d) => !callerSet.has(d));
      if (overreach.length > 0) {
        throw new PtcContractError("tasks.delegate", `domains 子集校验失败：${overreach.join(", ")} 不在调用者 domains 内`);
      }
      childDomains = requested;
    } else {
      childDomains = callerDomains;
    }

    // P1-1：delegate 显式 domains 子集时，必须按选中 domains 重构造 domainBinding——
    // 只保留 domainId ∈ childDomains 的 matches；primaryDomain 优先保留父 primary（若仍选中），
    // 否则取父 matches 顺序中第一个保留项；catalogVersion/resolverVersion 与父一致。
    // 保留集为空 → 报错（不产出空 binding，避免 claim reader 丢弃合法 binding）。
    let childDomainBinding: DomainBinding | undefined = caller.domainBinding;
    if (caller.domainBinding && explicitSubset) {
      const childSet = new Set(childDomains);
      const matches = caller.domainBinding.matches.filter((m) => childSet.has(m.domainId));
      if (matches.length === 0) {
        throw new PtcContractError("tasks.delegate", "domains 子集裁剪后 domainBinding.matches 为空");
      }
      const primaryDomain = caller.domainBinding.primaryDomain && childSet.has(caller.domainBinding.primaryDomain)
        ? caller.domainBinding.primaryDomain
        : matches[0]!.domainId;
      childDomainBinding = {
        matches,
        primaryDomain,
        catalogVersion: caller.domainBinding.catalogVersion,
        resolverVersion: caller.domainBinding.resolverVersion,
      };
    }

    // D3：组织权 fail-fast——违规不进入任务池、无 draft 旁路
    const allowed = allowedDelegationTargets(caller.roleId);
    if (!allowed.includes(to)) {
      throw new PtcContractError(
        "tasks.delegate",
        `组织权拒绝：${caller.roleId} 不可投递 ${to}（可投递: ${allowed.length > 0 ? allowed.join("/") : "无"}）`,
      );
    }

    // 标签注册表校验（worker 输入同样受严格模式约束；MID 目标无标签时允许空 tags——
    // 路由由服务端 delegateTarget 强制）
    const tags = Array.isArray(input.tags) ? input.tags.map((t) => t.trim()) : [];
    if (tags.length > 0) {
      const v = tagRegistry.validate(tags);
      if (!v.ok) {
        throw new PtcContractError("tasks.delegate", `未知标签: ${v.unknown.join(", ")}`);
      }
    }

    // 模板解析（A+ 统一收口——title/text 由模板渲染，delegateTarget 仍强制 = to）
    let finalTitle = title;
    let finalText = text;
    let templatePayload: Record<string, unknown> = {};
    let templateGoal: string | undefined;
    let finalTags = tags;
    if (typeof input.template === "string" && input.template.trim() !== "") {
      const r = resolveTemplateTask({
        template: input.template.trim(),
        params: input.params ?? {},
        title,
        tags,
      });
      if (!r.ok) {
        throw new PtcContractError("tasks.delegate", `${r.code}: ${r.error}${r.missing ? `（缺失: ${r.missing.join(", ")}）` : ""}`);
      }
      finalTitle = r.title;
      finalText = r.text;
      templatePayload = r.payload;
      templateGoal = r.goal;
      finalTags = r.tags;
    }

    // 服务器端盖章：parent/path/lineageId 只能由调用者身份生成
    const callerDelivery = caller.delivery && isTaskDeliveryStructurallyValid(caller.delivery)
      ? caller.delivery
      : buildEntryDelivery(caller.taskId, caller.roleId);
    if (!callerDelivery) {
      throw new PtcContractError("tasks.delegate", "调用者任务上下文无效（taskId/roleId 缺失）");
    }
    const delivery: TaskDelivery = {
      parent: { taskId: caller.taskId, roleId: caller.roleId, typePath: callerDelivery.path },
      path: [...callerDelivery.path, to],
      lineageId: callerDelivery.lineageId,
      replyTo: "parent",
      // 生命周期 P0：goal 逐字传播（不可转述——抗衰减是目的本身）；
      // 父任务已有 goal 时优先逐字继承；否则模板默认 goal 作为子任务根目标。
      ...(callerDelivery.goal !== undefined
        ? { goal: callerDelivery.goal }
        : templateGoal
          ? { goal: templateGoal }
          : {}),
    };
    const payload = {
      ...templatePayload,
      delivery,
      // 服务端盖章：domains/domainBinding 由调用者封套派生（body 不可自报）；
      // 显式子集时 domainBinding 已按子集裁剪（P1-1）。
      domains: [...childDomains],
      ...(childDomainBinding ? { domainBinding: childDomainBinding } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...(input.expect !== undefined ? { expect: input.expect } : {}),
    };

    const parentWorkMode = await this.resolveParentWorkMode(caller, scope);
    if (!this.deps.store.publishInTx) {
      throw new PtcContractError("tasks.delegate", "当前 TaskStore 不支持事务内发布（publishInTx 缺失）——无法保证 child/submission/dependency 原子写入");
    }

    // 持久化子任务委派 V1：canonical spec digest + submissionKey 幂等。
    const specDigest = canonicalDelegateSpecDigest({
      to,
      title: finalTitle,
      text: finalText,
      context: input.context ?? null,
      domains: childDomains,
      expect: input.expect ?? null,
      dependency: input.dependency ?? "required",
    });
    const submissionKey = input.submissionKey ?? `derived:${specDigest}`;
    const derived = input.submissionKey === undefined;

    return withTx(this.deps.pool, async (client) => {
      // 并发同 key 收敛：同一 parent 的 delegate 在事务内串行化，避免 SELECT→INSERT 竞态。
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [scope.tenantId, caller.taskId],
      );
      // 持久化子任务委派 V1 P0：delegate 必须绑定服务器盖章的当前 Attempt/lease。
      // 生产路径（AgentTaskRunner）总会写入 caller.lease；legacy/测试 caller 无 lease 时保持兼容。
      if (caller.lease) {
        const parentRes = await client.query(
          `SELECT 1 FROM tasks
           WHERE id = $1 AND tenant_id = $2
             AND lease_id = $3 AND lease_generation = $4
             AND status = 'claimed'
             AND lease_expires_at IS NOT NULL AND lease_expires_at > now()
           FOR UPDATE`,
          [caller.taskId, scope.tenantId, caller.lease.leaseId, caller.lease.generation],
        );
        if ((parentRes.rowCount ?? 0) !== 1) {
          throw new PtcContractError(
            "tasks.delegate",
            `父任务 lease 已失效/已终态/已被取消（task=${caller.taskId}）——不允许继续创建子任务`,
          );
        }
      }
      const existingRes = await client.query(
        `SELECT
           s.child_task_id, s.spec_digest, s.derived,
           t.status AS child_status,
           t.payload AS child_payload,
           t.payload->'delivery'->'artifactRef' AS artifact_ref,
           d.status AS dep_status,
           d.outcome_envelope AS outcome_envelope
         FROM task_submissions s
         LEFT JOIN tasks t ON t.id = s.child_task_id AND t.tenant_id = s.tenant_id
         LEFT JOIN task_dependencies d
           ON d.tenant_id = s.tenant_id
          AND d.parent_task_id = s.parent_task_id
          AND d.submission_key = s.submission_key
         WHERE s.tenant_id = $1 AND s.parent_task_id = $2 AND s.submission_key = $3`,
        [scope.tenantId, caller.taskId, submissionKey],
      );
      const existing = existingRes.rows[0] as
        | {
            child_task_id: string;
            spec_digest: string;
            child_status?: string | null;
            child_payload?: unknown;
            artifact_ref?: unknown;
            dep_status?: string | null;
            outcome_envelope?: unknown;
          }
        | undefined;
      if (existing) {
        if (existing.spec_digest !== specDigest) {
          observeSubmissionConflict();
          throw new PtcContractError("tasks.delegate", `submissionKey conflict: ${submissionKey}（同 key 不同 canonical spec）`);
        }
        // 第三轮 P0：重放同 submissionKey 时，若 child 已终态，则记录“本 Attempt 已消费该 observation”。
        // 只有后续 Attempt（consumed_lease_generation > created_lease_generation）才算消费，
        // 创建 dependency 的同一 Attempt 不能把自己刚创建的 child 当作已综合。
        const currentGeneration = caller.lease?.generation ?? 0;
        if (
          existing.child_status &&
          ["completed", "rejected", "escalated"].includes(existing.child_status)
        ) {
          await client.query(
            `UPDATE task_dependencies SET
               consumed_lease_generation = GREATEST(COALESCE(consumed_lease_generation, 0), $4),
               updated_at = now()
             WHERE tenant_id = $1 AND parent_task_id = $2 AND submission_key = $3
               AND status IN ('pending','satisfied','failed','cancelled')`,
            [scope.tenantId, caller.taskId, submissionKey, currentGeneration],
          );
        }
        return delegateResultFromRow({
          taskId: existing.child_task_id,
          submissionKey,
          roleId: to,
          path: delivery.path,
          childStatus: existing.child_status,
          childPayload: existing.child_payload,
          outcomeEnvelope: existing.outcome_envelope,
          artifactRef: existing.artifact_ref,
        });
      }

      // 写入前 admission：per-parent child 与 open dependency 硬上限。
      const maxChildren = pthConfig().num("PTH_TASK_MAX_CHILDREN_PER_PARENT");
      const childCount = await client.query(
        `SELECT count(*)::int AS n FROM task_submissions WHERE tenant_id = $1 AND parent_task_id = $2`,
        [scope.tenantId, caller.taskId],
      );
      if (Number((childCount.rows[0] as { n?: number } | undefined)?.n ?? 0) >= maxChildren) {
        observeAdmissionRejected("child-limit");
        throw new PtcContractError("tasks.delegate", `子任务数量超过上限 ${maxChildren}（parent=${caller.taskId}）`);
      }
      const maxOpen = pthConfig().num("PTH_TASK_MAX_OPEN_DEPENDENCIES_PER_PARENT");
      const openCount = await client.query(
        `SELECT count(*)::int AS n FROM task_dependencies WHERE tenant_id = $1 AND parent_task_id = $2 AND status = 'pending'`,
        [scope.tenantId, caller.taskId],
      );
      if (Number((openCount.rows[0] as { n?: number } | undefined)?.n ?? 0) >= maxOpen) {
        observeAdmissionRejected("open-dependency-limit");
        throw new PtcContractError("tasks.delegate", `未决 required dependency 数量超过上限 ${maxOpen}（parent=${caller.taskId}）`);
      }

      const task = await this.deps.store.publishInTx!(client, {
        title: finalTitle,
        text: finalText,
        createdBy: `worker:${caller.roleId}`,
        tenantId: scope.tenantId,
        tags: finalTags,
        payload,
        workMode: parentWorkMode,
        deliveryMode: "delegate",
        delegateTarget: to,
      });
      await client.query(
        `INSERT INTO task_submissions (tenant_id, parent_task_id, child_task_id, submission_key, spec_digest, derived)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [scope.tenantId, caller.taskId, task.id, submissionKey, specDigest, derived],
      );
      await client.query(
        `INSERT INTO task_dependencies (tenant_id, parent_task_id, child_task_id, submission_key, spec_digest, status, created_lease_generation)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
        [scope.tenantId, caller.taskId, task.id, submissionKey, specDigest, caller.lease?.generation ?? 0],
      );
      observeTaskSubmission(caller.roleId, to, derived);
      // 持久化子任务委派 V1 P0：不在 delegate 内清 lease / 切 waiting_dependency。
      // 父 Attempt 保持 claimed 直到 RoleRun 在安全边界退出；commit 见 pending dependency 时再 fence。
      return { taskId: task.id, roleId: to, path: delivery.path, submissionKey, state: "submitted" };
    });
  }

  /**
   * 生命周期 P1：pause 持久化——claimed → paused，释放 lease，写问题箱。
   * 幂等由 lease CAS 保证；返回是否真正落库（0 = 认领已被回收/跨租户/过期）。
   */
  async pause(input: {
    lease: TaskLease;
    work: TaskWorkItem;
    suspension: Extract<TaskSuspension, { kind: "publisher-question" }>;
  }): Promise<boolean> {
    const { lease, work, suspension } = input;
    const timeoutMs = pthConfig().num("PTH_TASK_PAUSE_TIMEOUT_MS");
    const pauseQuestion = {
      question: suspension.question,
      ...(suspension.context ? { context: suspension.context } : {}),
      askedAt: new Date().toISOString(),
      askedBy: work.assignedRole,
    };
    const res = await this.deps.pool.query(
      `UPDATE tasks SET
         status = 'paused',
         paused_at = now(),
         paused_expires_at = now() + ($6::bigint || ' milliseconds')::interval,
         claimed_by = NULL,
         claimed_at = NULL,
         lease_id = NULL,
         lease_expires_at = NULL,
         payload = jsonb_set(
           jsonb_set(
             jsonb_set(COALESCE(payload, '{}'::jsonb), '{pauseQuestion}', $4::jsonb, true),
             '{pauseAnswer}', 'null'::jsonb, true
           ),
           '{pauseCount}', to_jsonb(COALESCE((payload->>'pauseCount')::int, 0) + 1), true
         ),
         updated_at = now()
       WHERE id = $1 AND lease_id = $2 AND lease_generation = $3
         AND status = 'claimed' AND tenant_id = $5
         AND lease_expires_at IS NOT NULL AND lease_expires_at > now()
       RETURNING id`,
      [lease.taskId, lease.leaseId, lease.generation, JSON.stringify(pauseQuestion), lease.scope.tenantId, timeoutMs],
    );
    return (res.rowCount ?? 0) === 1;
  }

  /** 生命周期 P1：pause 超时/预算护栏——超时或 pauseCount≥3 的 paused 任务升级 escalated。 */
  async sweepExpiredPaused(): Promise<number> {
    const res = await this.deps.pool.query(
      `UPDATE tasks SET
         status = 'escalated',
         escalated_at = now(),
         updated_at = now()
       WHERE status = 'paused'
         AND (
           (paused_expires_at IS NOT NULL AND paused_expires_at < now())
           OR COALESCE((payload->>'pauseCount')::int, 0) >= 3
         )`,
    );
    return res.rowCount ?? 0;
  }

  /**
   * 生命周期 P1：tasks.answer——父 agent 回答自己直接子任务的 paused 问题。
   * 服务端校验直接父子关系；回答后子任务 paused → pending（重跑 + 澄清注入）。
   */
  async answer(
    input: { taskId: string; answer: string },
    caller: TaskDispatchContext,
    scope: TenantScope,
  ): Promise<{ ok: true }> {
    const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
    const answer = typeof input.answer === "string" ? input.answer.trim() : "";
    if (!taskId || !answer) {
      throw new PtcContractError("tasks.answer", "taskId/answer 必填（answer 非空）");
    }
    const res = await this.deps.pool.query(
      `SELECT id, tenant_id, status, payload FROM tasks WHERE id = $1 AND tenant_id = $2`,
      [taskId, scope.tenantId],
    );
    const row = res.rows[0] as
      | { id: string; tenant_id: string; status: string; payload: Record<string, unknown> | null }
      | undefined;
    if (!row) {
      throw new PtcContractError("tasks.answer", `任务 ${taskId} 不存在或不属于当前租户`);
    }
    const payload = row.payload ?? {};
    const delivery = payload["delivery"] as TaskDelivery | undefined;
    if (delivery?.parent?.taskId !== caller.taskId) {
      throw new PtcContractError(
        "tasks.answer",
        `任务 ${taskId} 不是当前任务的直接子任务（parent=${delivery?.parent?.taskId ?? "未盖章"}，当前=${caller.taskId}）`,
      );
    }
    if (row.status !== "paused") {
      throw new PtcContractError("tasks.answer", `任务 ${taskId} 当前状态 ${row.status}，仅 paused 可回答`);
    }
    const pauseAnswer = {
      answer,
      answeredBy: scope.principalId,
      answeredAt: new Date().toISOString(),
    };
    const upd = await this.deps.pool.query(
      `UPDATE tasks SET
         status = 'pending',
         paused_expires_at = NULL,
         payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{pauseAnswer}', $4::jsonb, true),
         updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'paused'`,
      [taskId, scope.tenantId, JSON.stringify(pauseAnswer)],
    );
    if ((upd.rowCount ?? 0) !== 1) {
      throw new PtcContractError("tasks.answer", `任务 ${taskId} 回答失败（并发状态变化？）`);
    }
    return { ok: true };
  }

  /**
   * 生命周期 P1：HTTP 人工回答——发布者是人类（入口任务）时回答任意 paused 任务。
   * 不要求调用者是父任务；仅校验租户与 paused 状态。
   */
  async answerHuman(taskIdInput: string, answerInput: string, scope: TenantScope): Promise<{ ok: true }> {
    const taskId = typeof taskIdInput === "string" ? taskIdInput.trim() : "";
    const answer = typeof answerInput === "string" ? answerInput.trim() : "";
    if (!taskId || !answer) {
      throw new PtcContractError("tasks.answer", "taskId/answer 必填（answer 非空）");
    }
    const res = await this.deps.pool.query(
      `SELECT id, tenant_id, status FROM tasks WHERE id = $1 AND tenant_id = $2`,
      [taskId, scope.tenantId],
    );
    const row = res.rows[0] as { id: string; tenant_id: string; status: string } | undefined;
    if (!row) {
      throw new PtcContractError("tasks.answer", `任务 ${taskId} 不存在或不属于当前租户`);
    }
    if (row.status !== "paused") {
      throw new PtcContractError("tasks.answer", `任务 ${taskId} 当前状态 ${row.status}，仅 paused 可回答`);
    }
    const pauseAnswer = {
      answer,
      answeredBy: scope.principalId,
      answeredAt: new Date().toISOString(),
    };
    const upd = await this.deps.pool.query(
      `UPDATE tasks SET
         status = 'pending',
         paused_expires_at = NULL,
         payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{pauseAnswer}', $4::jsonb, true),
         updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'paused'`,
      [taskId, scope.tenantId, JSON.stringify(pauseAnswer)],
    );
    if ((upd.rowCount ?? 0) !== 1) {
      throw new PtcContractError("tasks.answer", `任务 ${taskId} 回答失败（并发状态变化？）`);
    }
    return { ok: true };
  }

  /**
   * W8 P1：tasks.await 契约（用户裁决：P1=一次性状态查询，不轮询、不挂起；
   * P2 会替换为事件驱动挂起 + 父任务 requeue）。
   * 只允许查询当前任务的直接子任务（delivery.parent.taskId 校验），跨租户/越权即拒绝。
   */
  async awaitTask(input: TaskAwaitInput, caller: TaskDispatchContext, scope: TenantScope): Promise<TaskAwaitResult> {
    const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
    if (!taskId) throw new PtcContractError("tasks.await", "taskId 必填");
    if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== "number" || !Number.isFinite(input.timeoutMs) || input.timeoutMs < 0)) {
      throw new PtcContractError("tasks.await", "timeoutMs 可选——若提供必须是非负有限数字");
    }
    if (input.detach !== undefined && typeof input.detach !== "boolean") {
      throw new PtcContractError("tasks.await", "detach 可选——若提供必须是布尔值");
    }

    const res = await this.deps.pool.query(
      `SELECT status, title, payload FROM tasks WHERE id = $1 AND tenant_id = $2`,
      [taskId, scope.tenantId],
    );
    const row = res.rows[0] as { status: string; title: string; payload: Record<string, unknown> } | undefined;
    if (!row) {
      throw new PtcContractError("tasks.await", `任务 ${taskId} 不存在或不属于当前租户`);
    }

    const payload = row.payload ?? {};
    const delivery = payload["delivery"] as TaskDelivery | undefined;
    const parentTaskId = delivery?.parent?.taskId;
    if (!parentTaskId || parentTaskId !== caller.taskId) {
      throw new PtcContractError(
        "tasks.await",
        `任务 ${taskId} 不是当前任务的直接子任务（parent=${parentTaskId ?? "未盖章"}，当前=${caller.taskId}）`,
      );
    }

    if (row.status === "completed") {
      const result = payload["result"] ?? null;
      return {
        status: "completed",
        result,
        artifactRef: delivery?.artifactRef ?? null,
        summary: resultSummary(result),
      };
    }
    if (row.status === "rejected") {
      const result = payload["result"] ?? null;
      const errObj = (result as { error?: { code: string; message: string } } | null)?.error;
      return {
        status: "rejected",
        result,
        artifactRef: delivery?.artifactRef ?? null,
        error: errObj ?? { code: "rejected", message: "任务被拒绝" },
      };
    }
    // W8 P2：未终态 → 登记等待集合（payload.dispatchWait[childTaskId]）并抛挂起信号。
    // runner 收到 code=task-await-suspended 后把父任务落 retryable rejected（释放认领回 pending）；
    // 子任务终态事件 → 主进程 task-dispatch-notifier 写 payload.childResult 并清理登记。
    const at = new Date().toISOString();
    const registered = await this.deps.pool.query(
      `UPDATE tasks SET
         payload = jsonb_set(
           jsonb_set(COALESCE(payload, '{}'::jsonb), '{dispatchWait}', COALESCE(payload->'dispatchWait', '{}'::jsonb), true),
           ARRAY['dispatchWait',$3]::text[], $4::jsonb, true),
         updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status IN ('pending','claimed','submitted','waiting_dependency')`,
      [caller.taskId, scope.tenantId, taskId, JSON.stringify({ at })],
    );
    if ((registered.rowCount ?? 0) === 0) {
      throw new PtcContractError("tasks.await", `父任务 ${caller.taskId} 不可登记等待（不存在/跨租户/已终态）`);
    }
    throw new TaskAwaitSuspendedError(taskId, `等待子任务 ${taskId} 终态（当前 ${row.status}）——父任务已挂起回队列，子任务完成后自动重跑`);
  }

  /**
   * W8 P2：取消传播——父任务取消时沿 payload.delivery.parent 链递归取消全部未终态子任务。
   * 递归 CTE 收集整棵派生子树（同租户内），一次 UPDATE 终态化 + 清认领/lease。
   */
  async cancel(taskIdInput: string, scope: TenantScope, opts: { recursive?: boolean } = {}): Promise<TaskCancelResult> {
    const taskId = String(taskIdInput ?? "").trim();
    if (!taskId) throw new PtcContractError("tasks.cancel", "taskId 必填");
    const recursive = opts.recursive === true;
    const root = await this.deps.pool.query("SELECT id FROM tasks WHERE id = $1 AND tenant_id = $2", [taskId, scope.tenantId]);
    if (root.rows.length === 0) {
      throw new PtcContractError("tasks.cancel", `任务 ${taskId} 不存在或不属于当前租户`);
    }
    const errorSummary = JSON.stringify({ error: { code: "cancelled", message: "任务已取消" } });
    return withTx(this.deps.pool, async (client) => {
      const res = await client.query(
        `WITH RECURSIVE lineage(id) AS (
           SELECT id FROM tasks WHERE id = $1 AND tenant_id = $2
           ${recursive ? `UNION
           SELECT d.child_task_id
           FROM task_dependencies d
           JOIN lineage l ON d.parent_task_id = l.id AND d.tenant_id = $2` : ""}
         )
         UPDATE tasks SET
           status = 'rejected',
           escalated_at = now(),
           waiting_dependency_at = NULL,
           claimed_by = NULL,
           claimed_at = NULL,
           lease_id = NULL,
           lease_expires_at = NULL,
           payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{result}', $3::jsonb, true),
           updated_at = now()
         WHERE id IN (SELECT id FROM lineage) AND tenant_id = $2 AND status IN ('pending','claimed','submitted','waiting_dependency')
         RETURNING id`,
        [taskId, scope.tenantId, errorSummary],
      );
      const taskIds = (res.rows as Array<{ id: string }>).map((r) => r.id);
      if (taskIds.length > 0) {
        const depRes = await client.query(
          `UPDATE task_dependencies SET
             status = 'cancelled',
             outcome_envelope = $3::jsonb,
             updated_at = now()
           WHERE tenant_id = $1 AND child_task_id = ANY($2::text[]) AND status IN ('pending','satisfied','failed')`,
          [scope.tenantId, taskIds, JSON.stringify({ status: "cancelled", summary: "任务已取消", provenance: [], artifactRefs: [] })],
        );
        observeDependencyStatus("cancelled", depRes.rowCount ?? 0);
      }
      return { cancelled: res.rowCount ?? 0, taskIds };
    });
  }

  /** 观测列表（全部状态、created_at 倒序）——保持 gateway 既有 JSON 形状，仅加租户过滤 */
  async list(scope: TenantScope, limit: number): Promise<Array<Record<string, unknown>>> {
    const res = await this.deps.pool.query(
      `SELECT id, title, text, tags, status, claimed_by, claims_count, created_at, payload
       FROM tasks WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [scope.tenantId, Math.min(Math.max(limit, 1), 200)],
    );
    return res.rows as Array<Record<string, unknown>>;
  }

  async get(scope: TenantScope, id: string): Promise<Record<string, unknown> | null> {
    const res = await this.deps.pool.query("SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2", [id, scope.tenantId]);
    return (res.rows[0] as Record<string, unknown> | undefined) ?? null;
  }
}
