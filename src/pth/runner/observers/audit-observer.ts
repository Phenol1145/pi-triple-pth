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
    if (outcome.status === "completed") {
      await deps.write({
        eventType: "task_completed",
        actor: work.scope.principalId,
        taskId: work.taskId,
        tenantId: work.scope.tenantId,
        payload: { submitAffected: 1 },
      });
      return;
    }
    await deps.write({
      eventType: outcome.retryable === true ? "task_requeued" : "task_rejected",
      actor: work.scope.principalId,
      taskId: work.taskId,
      tenantId: work.scope.tenantId,
      payload: { reason: reason.slice(0, 300) },
    });
  };
}
