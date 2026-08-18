/**
 * runner/observers/transcript-observer.ts — 轨迹持久化 fan-out（模块化 v2 P1-7）。
 *
 * 只消费 context.traceEvents；无轨迹（PTC fast-path）则零写入。
 * tenantId 随 work.scope 持久化。
 */

import type { TaskOutcomeObserverFn } from "../../tasking/index.js";

export interface TranscriptObserverDeps {
  create(input: {
    taskId?: string;
    agentId: string;
    body: unknown[];
    summary?: string;
    tenantId?: string;
  }): Promise<unknown>;
}

export function createTranscriptObserver(deps: TranscriptObserverDeps): TaskOutcomeObserverFn {
  return async (event) => {
    const trace = event.context?.["traceEvents"];
    if (!Array.isArray(trace) || trace.length === 0) return;
    const result = event.outcome.result as { summary?: string; value?: unknown } | undefined;
    const summary =
      event.outcome.status === "completed"
        ? (result?.summary ?? (result?.value !== undefined && result?.value !== null ? JSON.stringify(result.value).slice(0, 200) : ""))
        : (event.outcome.error?.message ?? "").slice(0, 200);
    await deps.create({
      taskId: event.work.taskId,
      agentId: event.work.assignedRole,
      body: trace,
      summary,
      tenantId: event.work.scope.tenantId,
    });
  };
}
