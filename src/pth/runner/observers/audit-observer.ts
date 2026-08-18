/**
 * runner/observers/audit-observer.ts — 审计 fan-out（模块化 v2 P1-7）。
 *
 * committed 后才写 PG audit_log；写入必须带 work.scope.tenantId（多租户审计边界）。
 */

import type { TaskOutcomeObserverFn } from "../../tasking/index.js";

export interface AuditObserverDeps {
  write(ev: {
    eventType: string;
    actor?: string;
    taskId?: string;
    workerId?: string;
    tenantId?: string;
    payload?: unknown;
  }): Promise<void>;
}

export function createAuditObserver(deps: AuditObserverDeps): TaskOutcomeObserverFn {
  return async (event) => {
    const { outcome, work } = event;
    const reason = outcome.error?.message ?? "unknown";
    // N28 T2：server-stamped worker principal 与 role 分字段记录；无 replica 的 legacy principal 原样保留。
    const principalId = work.scope.principalId;
    const workerStamp = principalId.startsWith("worker:") ? { workerId: principalId.slice("worker:".length) } : {};
    const roleId = work.scope.roles[0] ?? work.assignedRole;
    if (outcome.status === "completed") {
      const payload: Record<string, unknown> = { submitAffected: 1 };
      if (workerStamp.workerId) payload.roleId = roleId;
      await deps.write({
        eventType: "task_completed",
        actor: principalId,
        taskId: work.taskId,
        tenantId: work.scope.tenantId,
        ...workerStamp,
        payload,
      });
      return;
    }
    const payload: Record<string, unknown> = { reason: reason.slice(0, 300) };
    if (workerStamp.workerId) payload.roleId = roleId;
    await deps.write({
      eventType: outcome.retryable === true ? "task_requeued" : "task_rejected",
      actor: principalId,
      taskId: work.taskId,
      tenantId: work.scope.tenantId,
      ...workerStamp,
      payload,
    });
  };
}
