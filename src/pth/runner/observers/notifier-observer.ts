/**
 * runner/observers/notifier-observer.ts — 完成通知 fan-out（模块化 v2 P1-7）。
 *
 * PTH → PTL 完成通知（pth-notify 扩展），fire-and-forget（超时 2s，失败仅告警）。
 */

import type { TaskOutcomeObserver } from "../../tasking/index.js";

export function notifyTaskDone(ev: { taskId: string; role: string; status: "completed" | "rejected"; summary?: string; error?: string }): void {
  const url = process.env.PTH_NOTIFY_URL ?? "http://host.docker.internal:19473/pth-events";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...ev, ts: Date.now() }),
    signal: ctrl.signal,
  }).catch(() => { /* 通知不可达（PTL 未运行/扩展未装载）——静默 */ })
    .finally(() => clearTimeout(timer));
}

export function createNotifierObserver(): TaskOutcomeObserver {
  return async (event) => {
    const { outcome, work } = event;
    if (outcome.status === "completed") {
      const result = outcome.result as { summary?: string } | undefined;
      notifyTaskDone({ taskId: work.taskId, role: work.assignedRole, status: "completed", summary: result?.summary });
      return;
    }
    if (outcome.retryable === true) return; // 回池重试不属于 PTL 终态通知
    notifyTaskDone({ taskId: work.taskId, role: work.assignedRole, status: "rejected", error: outcome.error?.message });
  };
}
