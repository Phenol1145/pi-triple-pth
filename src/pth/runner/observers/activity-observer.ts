/**
 * runner/observers/activity-observer.ts — 活动事件 fan-out（模块化 v2 P1-7）。
 *
 * 只处理 committed 后的事件面；agent step/tool/finish 仍由 runner onTrace 直发。
 */

import type { TaskOutcomeObserver } from "../../tasking/index.js";

export interface ActivityObserverDeps {
  emit(e: {
    kind: string;
    taskId?: string;
    role?: string;
    ok?: boolean;
    detail?: string;
    chainDepth?: number;
    triggerId?: string;
  }): void;
}

export function createActivityObserver(deps: ActivityObserverDeps): TaskOutcomeObserver {
  return async (event) => {
    const { outcome, work } = event;
    const chain = (event.context?.["chain"] ?? {}) as { chainDepth?: number; triggerId?: string };
    const reason = outcome.error?.message ?? "unknown";
    if (outcome.status === "completed") return; // agent 路径由 onTrace finish 发射；PTC 完成通知走 notifier
    deps.emit({
      kind: outcome.retryable === true ? "task.requeued" : "task.rejected",
      taskId: work.taskId,
      role: work.assignedRole,
      ok: false,
      detail: reason.slice(0, 120),
      ...chain,
    });
  };
}
