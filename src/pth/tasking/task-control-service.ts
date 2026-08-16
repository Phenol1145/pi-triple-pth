/**
 * tasking/task-control-service.ts — 任务控制服务（模块化 v2 P1-3）。
 *
 * publish 的 createdBy/tenantId 只从服务器端 TenantScope 派生；body 自报字段不可覆盖。
 * list/get 按 scope.tenantId 过滤（跨租户 get 返回 null、list 为空——路由 JSON 形状不变）。
 * W8 P1：delegate/awaitTask 是父→子投递原语的服务器侧唯一入口——组织权矩阵 + 盖章 + 标签校验。
 */

import type pg from "pg";
import type { Task, TaskStore } from "../kernel/storage/task-store-pg.js";
import type { PublishInput } from "../kernel/storage/task-store-pg.js";
import {
  buildEntryDelivery,
  isTaskDeliveryStructurallyValid,
  type TaskAwaitInput,
  type TaskAwaitResult,
  type TaskDelegateInput,
  type TaskDelegateResult,
  type TaskDelivery,
  type TaskDispatchContext,
  type TenantScope,
} from "../contracts/index.js";
import { PgTaskQueries } from "./task-queries.js";
import { allowedDelegationTargets } from "./delegation-policy.js";
import { tagRegistry } from "../kernel/execution/tag-registry.js";
import { resolveTemplateTask } from "../kernel/templates.js";
import { PtcContractError } from "../kernel/ptc/contract.js";

export interface TaskControlServiceDeps {
  store: Pick<TaskStore, "publish">;
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

export class TaskControlService {
  constructor(private deps: TaskControlServiceDeps) {}

  async publish(
    input: Omit<PublishInput, "createdBy" | "tenantId"> & { createdBy?: string; tenantId?: string },
    scope: TenantScope,
  ): Promise<Task> {
    // P1-3：服务器端盖章——body 里的 createdBy/tenantId 一律丢弃。
    // W8 P0：外部入口恒盖 entry delivery（path=[assignedRole]、lineageId=taskId）。
    const { createdBy: _createdBy, tenantId: _tenantId, ...rest } = input;
    return this.deps.store.publish({
      ...rest,
      createdBy: scope.principalId,
      tenantId: scope.tenantId,
      deliveryMode: "entry",
    });
  }

  /**
   * W8 P1：tasks.delegate 服务端实现（调用即拒绝——D3）。
   * 组织权矩阵在进入任务池前校验；parent/path/lineageId 全部由调用者身份盖章，
   * body 只允许任务内容/模板/标签/上下文/回流预期。
   */
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
    };
    const payload = {
      ...templatePayload,
      delivery,
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...(input.expect !== undefined ? { expect: input.expect } : {}),
    };

    const task = await this.deps.store.publish({
      title: finalTitle,
      text: finalText,
      createdBy: `worker:${caller.roleId}`,
      tenantId: scope.tenantId,
      tags: finalTags,
      payload,
      deliveryMode: "delegate",
      delegateTarget: to,
    });
    return { taskId: task.id, roleId: to, path: delivery.path };
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
    return { status: row.status, waiting: true, result: null, artifactRef: delivery?.artifactRef ?? null };
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
