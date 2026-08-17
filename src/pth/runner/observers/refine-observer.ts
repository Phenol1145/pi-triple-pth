/**
 * runner/observers/refine-observer.ts — 任务提炼 fan-out（模块化 v2 P1-7 / F5）。
 *
 * F5：不再依赖 BoundedBackgroundQueue（满则丢弃）。post-commit observer 同步 await
 * enqueue 将 refine 副作用写入 durable outbox；真正的 LLM refine 由 drainer 异步消费。
 * 写入失败必须抛给 notifyObservers 记日志，不能静默丢失。
 */

import type { TaskOutcomeObserver } from "../../tasking/index.js";

export interface RefineObserverDeps {
  enqueue: (key: string, kind: string, payload: unknown) => Promise<void>;
  kernel: {
    snapshot(): Promise<unknown> | unknown;
  };
  roleId: string;
  logger?: (msg: string) => void;
}

export function createRefineObserver(deps: RefineObserverDeps): TaskOutcomeObserver {
  return async (event) => {
    if (event.outcome.status !== "completed") return;
    const task = event.context?.["task"];
    if (!task) return;
    const taskPayload = (task as { payload?: { refine?: string } }).payload;
    if (taskPayload?.refine === "off") return;
    const taskRecord = task as {
      id?: string;
      title?: string;
      tags?: string[];
      claimed_by?: string | null;
      tenantId?: string;
    };
    const taskId = taskRecord.id;
    if (!taskId) return;
    // 租户边界以 work.scope 为准（与 audit/transcript observer 同口径）。
    const tenantId = event.work.scope.tenantId ?? taskRecord.tenantId ?? "default";
    const trace = event.context?.["traceEvents"];
    const artifactRefs = event.outcome.artifacts?.map((a) => a.uri) ?? [];

    // snapshot 必须同步完成（下一任务 reset 会清 context）——snapshot 失败沿用旧降级：记日志、跳过。
    let snapshot: unknown;
    try {
      snapshot = await deps.kernel.snapshot();
    } catch (e) {
      deps.logger?.(`refine snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // 幂等 key：同一任务同一 lease generation 只会入队一次。
    const key = `refine:${tenantId}:${taskId}:${event.lease.generation}`;
    const payload = {
      taskId,
      roleId: deps.roleId,
      tenantId,
      task: {
        id: taskId,
        title: taskRecord.title ?? "",
        tags: taskRecord.tags ?? [],
        claimed_by: taskRecord.claimed_by ?? null,
      },
      traceEvents: Array.isArray(trace) ? trace.slice(0, 60) : [],
      domains: event.work.domains ?? [],
      ...(event.work.domainBinding ? { domainBinding: event.work.domainBinding } : {}),
      outcome: { status: event.outcome.status, result: event.outcome.result },
      artifactRefs,
      snapshot,
    };
    await deps.enqueue(key, "refine", payload);
  };
}
