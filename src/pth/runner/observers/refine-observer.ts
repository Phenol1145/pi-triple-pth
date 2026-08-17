/**
 * runner/observers/refine-observer.ts — 任务提炼 fan-out（模块化 v2 P1-7）。
 *
 * 慢路径：snapshot 同步完成（下一任务 reset 前），LLM refine 入有界后台队列，
 * 不阻塞下一轮 claim。
 */

import type { TaskOutcomeObserver } from "../../tasking/index.js";
import type { BoundedBackgroundQueue } from "../../tasking/index.js";

export interface RefineObserverDeps {
  queue: BoundedBackgroundQueue;
  kernel: {
    snapshot(): Promise<unknown> | unknown;
  };
  refiner: {
    refine(input: never): Promise<unknown>;
  };
  roleId: string;
  logger?: (msg: string) => void;
}

export function createRefineObserver(deps: RefineObserverDeps): TaskOutcomeObserver {
  return async (event) => {
    if (event.outcome.status !== "completed") return;
    const task = event.context?.["task"];
    if (!task) return;
    const payload = (task as { payload?: { refine?: string } }).payload;
    if (payload?.refine === "off") return;
    const trace = event.context?.["traceEvents"];
    const tenantId = (task as { tenantId?: string } | undefined)?.tenantId ?? "default";
    const artifactRefs = event.outcome.artifacts?.map((a) => a.uri);
    try {
      const snap = await deps.kernel.snapshot();
      deps.queue.enqueue(async () => {
        await deps.refiner.refine({
          task,
          snapshot: snap,
          scope: { tenantId, space: "meta" },
          trace: Array.isArray(trace) ? trace : undefined,
          role: deps.roleId,
          outcome: { status: event.outcome.status, result: event.outcome.result },
          ...(artifactRefs && artifactRefs.length > 0 ? { artifactRefs } : {}),
        } as never);
      });
    } catch (e) {
      deps.logger?.(`refine snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}
