/**
 * runner/observers/metrics-observer.ts — 性能计量 fan-out（模块化 v2 P1-7）。
 */

import type { TaskOutcomeObserverFn } from "../../tasking/index.js";

export interface MetricsObserverDeps {
  metric(m: Record<string, unknown>): void;
  /** 拒绝原因分类器（execution-failed/crashed/timeout/other） */
  classifyReason?(reason: string): string;
}

export function createMetricsObserver(deps: MetricsObserverDeps): TaskOutcomeObserverFn {
  return async (event) => {
    const { outcome } = event;
    const execMs = Number(event.context?.["execMs"] ?? 0);
    if (outcome.status === "completed") {
      deps.metric({ type: "status", status: "completed" });
      deps.metric({ type: "stage", stage: "execute", durationMs: execMs });
      return;
    }
    if (outcome.retryable === true) {
      deps.metric({ type: "status", status: "requeued" });
      return;
    }
    deps.metric({ type: "status", status: "rejected" });
    deps.metric({ type: "reject-reason", reason: deps.classifyReason?.(outcome.error?.message ?? "unknown") ?? "other" });
    deps.metric({ type: "stage", stage: "execute", durationMs: execMs });
  };
}
