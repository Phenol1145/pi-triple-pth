/**
 * runner/observers/optimizer-observer.ts — 优化循环 fan-out（模块化 v2 P1-7）。
 *
 * 慢路径：scorecard 聚合 + collect 入有界后台队列，不阻塞下一轮 claim。
 */

import type { TaskOutcomeObserver } from "../../tasking/index.js";
import type { BoundedBackgroundQueue } from "../../tasking/index.js";

export interface OptimizerObserverDeps {
  queue: BoundedBackgroundQueue;
  optimizer: {
    collect(scorecard: unknown, ctx: { role: string; taskId: string; tenantId?: string; verifyOf?: string }): Promise<unknown> | void;
  };
  buildScorecard(trace: unknown[]): unknown;
  computeTimeReuse?(subtasks: Array<{ id?: string; dependsOn?: string[] }>): number | null;
  roleId: string;
  logger?: (msg: string) => void;
}

export function createOptimizerObserver(deps: OptimizerObserverDeps): TaskOutcomeObserver {
  return async (event) => {
    if (event.outcome.status !== "completed") return;
    const trace = event.context?.["traceEvents"];
    if (!Array.isArray(trace) || trace.length === 0) return;
    const task = event.context?.["task"] as { id?: string; tenantId?: string; payload?: { verifyOf?: string } } | undefined;
    const result = event.outcome.result as { value?: unknown } | undefined;
    deps.queue.enqueue(async () => {
      const sc = deps.buildScorecard(trace) as { timeReuse?: number | null };
      const value = result?.value as Record<string, unknown> | undefined;
      const subtasks = value?.["subtasks"];
      if (Array.isArray(subtasks) && subtasks.length > 0 && deps.computeTimeReuse) {
        sc.timeReuse = deps.computeTimeReuse(subtasks as Array<{ id?: string; dependsOn?: string[] }>);
      }
      await deps.optimizer.collect(sc, { role: deps.roleId, taskId: task?.id ?? event.work.taskId, tenantId: task?.tenantId ?? "default", verifyOf: task?.payload?.verifyOf });
    });
  };
}
