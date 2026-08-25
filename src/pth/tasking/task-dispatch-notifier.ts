/**
 * tasking/task-dispatch-notifier.ts —— W8 P2 事件驱动回流（docs/w8-task-dispatch-design.md §6）。
 *
 * 子任务终态事件（batch → 主进程 ActivityHub）到达后：
 *  1. 按 child.payload.delivery.parent.taskId 反查父任务；
 *  2. 父任务未终态 → 写 payload.childResult[childId]（status/result/artifactRef/error 摘要）；
 *  3. 清理 payload.dispatchWait[childId] 等待登记；
 *  4. 父任务此刻应已由 await 挂起信号落回 pending（不占 claim）——worker 下一轮自动认领重跑，
 *     任务程序用 tasks.resume() 读 childResult 续接（不重复 delegate）。
 *
 * 持久化子任务委派 V1（M2）：
 *  - task_dependencies 是生命周期真相源；child terminal 时先更新 dependency 行；
 *  - 所有 required dependency 终态后，父任务从 waiting_dependency 回到 pending（requeue）；
 *  - 事件仍只做低延迟提示，进程重启后的最终收敛由 TaskDependencyReconciler 负责。
 *
 * 幂等：同一子任务多次终态事件重复 UPDATE 同一键，无副作用。
 */

import type pg from "pg";
import type { ChildOutcomeEnvelopeV1, TaskAwaitResult, TaskDelivery } from "@away_from/pth-contracts";
import { withTx } from "@away_from/pth-kernel-storage";
import { observeDependencyStatus } from "./task-dependency-metrics.js";

export interface TaskDispatchNotifierDeps {
  pool: pg.Pool;
  activityHub: {
    subscribe(handler: (e: { kind?: string; taskId?: string }) => void): () => void;
  };
  logger?: (msg: string) => void;
}

const HANDLED_EVENT_KINDS = new Set(["task.submit", "task.reject", "task.done", "task.failed", "task.pause"]);
const NON_TERMINAL_STATUSES = "status NOT IN ('completed','rejected')";

function summarize(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as { summary?: unknown; value?: { summary?: unknown }; stdout?: unknown };
  const s = r.summary ?? r.value?.summary ?? r.stdout;
  return typeof s === "string" && s !== "" ? s.slice(0, 2000) : undefined;
}

function outcomeStatusFromChild(child: { status: string; payload: Record<string, unknown> | null }): ChildOutcomeEnvelopeV1["status"] {
  if (child.status === "completed") return "completed";
  if (child.status === "escalated") return "escalated";
  if (child.status === "rejected") {
    const result = child.payload?.["result"];
    const code = (result as { error?: { code?: unknown } } | null | undefined)?.error?.code;
    return code === "cancelled" ? "cancelled" : "rejected";
  }
  return "rejected";
}

function outcomeEnvelopeFromChild(child: {
  status: string;
  payload: Record<string, unknown> | null;
  delivery?: TaskDelivery;
}): ChildOutcomeEnvelopeV1 {
  const result = child.payload?.["result"] ?? null;
  const errorObj = (result as { error?: { code?: unknown; message?: unknown } } | null | undefined)?.error;
  const artifactRef = child.delivery?.artifactRef;
  return {
    status: outcomeStatusFromChild(child),
    summary: summarize(result) ?? "",
    provenance: [],
    artifactRefs: artifactRef && typeof artifactRef.id === "string" ? [artifactRef.id] : [],
    ...(errorObj && typeof errorObj.code === "string" && typeof errorObj.message === "string"
      ? { error: { family: errorObj.code, message: errorObj.message, retryable: false as const } }
      : {}),
  };
}

/**
 * 处理单个子任务终态事件 → 更新 dependency 真相行 + 父任务 childResult 回写 + requeue。
 * 供 TaskDispatchNotifier.handle 与 TaskDependencyReconciler 共用；幂等。
 */
export async function applyChildTerminalToParent(
  pool: pg.Pool,
  childTaskId: string,
  logger?: (msg: string) => void,
): Promise<boolean> {
  const childRes = await pool.query(
    `SELECT id, tenant_id, status, payload FROM tasks WHERE id = $1`,
    [childTaskId],
  );
  const child = childRes.rows[0] as
    | { id: string; tenant_id: string; status: string; payload: Record<string, unknown> | null }
    | undefined;
  if (!child || !["completed", "rejected", "escalated", "paused"].includes(child.status)) return false;

  const childPayload = child.payload ?? {};
  const delivery = childPayload["delivery"] as TaskDelivery | undefined;
  const parentTaskId = delivery?.parent?.taskId;
  if (!parentTaskId) return false;

  const parentRes = await pool.query(
    `SELECT id, tenant_id, status FROM tasks WHERE id = $1 AND tenant_id = $2`,
    [parentTaskId, child.tenant_id],
  );
  const parent = parentRes.rows[0] as { id: string; tenant_id: string; status: string } | undefined;
  if (!parent) return false;
  const parentTerminal = parent.status === "completed" || parent.status === "rejected";

  return withTx(pool, async (client) => {
    // paused：对称通道写 childQuestion（父重跑后 tasks.resume/answer 读取）
    if (child.status === "paused") {
      const q = (childPayload["pauseQuestion"] ?? {}) as {
        question?: unknown; context?: unknown; askedAt?: unknown; askedBy?: unknown;
      };
      if (typeof q.question !== "string" || q.question.trim() === "") return false;
      const entry = {
        question: q.question,
        ...(q.context !== undefined && typeof q.context === "object" && q.context !== null ? { context: q.context as Record<string, unknown> } : {}),
        askedAt: typeof q.askedAt === "string" ? q.askedAt : new Date().toISOString(),
        askedBy: typeof q.askedBy === "string" ? q.askedBy : "",
      };
      const updated = await client.query(
        `UPDATE tasks SET
           payload = (jsonb_set(
             jsonb_set(COALESCE(payload, '{}'::jsonb), '{childQuestion}', COALESCE(payload->'childQuestion', '{}'::jsonb), true),
             ARRAY['childQuestion',$3]::text[], $4::jsonb, true))
             #- ARRAY['dispatchWait',$3]::text[],
           updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND ${NON_TERMINAL_STATUSES}`,
        [parentTaskId, child.tenant_id, childTaskId, JSON.stringify(entry)],
      );
      const did = (updated.rowCount ?? 0) > 0;
      if (did) logger?.(`[task-dispatch-notifier] child=${childTaskId} → parent=${parentTaskId}（paused 问题回流）`);
      return did;
    }

    let did = false;

    // 更新 dependency 真相行（即使父任务已终态也补写，供 reconciliation 对账）。
    const depStatus = child.status === "completed" ? "satisfied" : "failed";
    const envelope = outcomeEnvelopeFromChild({ ...child, delivery });
    const depRes = await client.query(
      `UPDATE task_dependencies SET
         status = $3,
         outcome_envelope = $4::jsonb,
         updated_at = now()
       WHERE tenant_id = $1 AND child_task_id = $2 AND status IN ('pending','satisfied','failed')
       RETURNING parent_task_id`,
      [child.tenant_id, childTaskId, depStatus, JSON.stringify(envelope)],
    );
    if (depRes.rows.length > 0) {
      did = true;
      observeDependencyStatus(depStatus, depRes.rowCount ?? 1);
    }

    if (!parentTerminal) {
      const result = childPayload["result"] ?? null;
      const artifactRef = delivery?.artifactRef ?? null;
      const errorObj = (result as { error?: { code: string; message: string } } | null | undefined)?.error;
      const entry: TaskAwaitResult = {
        status: child.status,
        result,
        artifactRef,
        summary: summarize(result),
        ...(errorObj ? { error: errorObj } : {}),
      };
      const updated = await client.query(
        `UPDATE tasks SET
           payload = (jsonb_set(
             jsonb_set(COALESCE(payload, '{}'::jsonb), '{childResult}', COALESCE(payload->'childResult', '{}'::jsonb), true),
             ARRAY['childResult',$3]::text[], $4::jsonb, true))
             #- ARRAY['dispatchWait',$3]::text[],
           updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND ${NON_TERMINAL_STATUSES}`,
        [parentTaskId, child.tenant_id, childTaskId, JSON.stringify(entry)],
      );
      if ((updated.rowCount ?? 0) > 0) did = true;

      // 所有 required dependencies 终态 → 父任务 requeue（waiting_dependency → pending）。
      const pending = await client.query(
        `SELECT 1 FROM task_dependencies
         WHERE tenant_id = $1 AND parent_task_id = $2 AND status = 'pending'
         LIMIT 1`,
        [child.tenant_id, parentTaskId],
      );
      if (pending.rows.length === 0) {
        const requeued = await client.query(
          `UPDATE tasks SET
             status = 'pending',
             waiting_dependency_at = NULL,
             updated_at = now()
           WHERE id = $1 AND tenant_id = $2 AND status = 'waiting_dependency'`,
          [parentTaskId, child.tenant_id],
        );
        if ((requeued.rowCount ?? 0) > 0) did = true;
      }
    }

    if (did) logger?.(`[task-dispatch-notifier] child=${childTaskId} → parent=${parentTaskId}（status=${child.status}）`);
    return did;
  });
}

export class TaskDispatchNotifier {
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(private deps: TaskDispatchNotifierDeps) {}

  /** 装配点：main 进程 ActivityHub 订阅（幂等——重复 start 忽略） */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.activityHub.subscribe((e) => {
      if (!HANDLED_EVENT_KINDS.has(e.kind ?? "") || typeof e.taskId !== "string" || e.taskId === "") return;
      void this.handle(e.taskId).catch((err: Error) => {
        this.deps.logger?.(`[task-dispatch-notifier] 回流失败 task=${e.taskId}: ${err.message}`);
      });
    });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  get isStopped(): boolean { return this.stopped; }

  /** 处理单个子任务终态事件 → 父任务 childResult 回写。返回是否有父任务被更新。 */
  async handle(childTaskId: string): Promise<boolean> {
    return applyChildTerminalToParent(this.deps.pool, childTaskId, this.deps.logger);
  }
}
