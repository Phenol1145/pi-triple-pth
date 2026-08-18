/**
 * runner/observers/refine-observer.ts — 任务提炼 fan-out（模块化 v2 P1-7 / F5 / R4）。
 *
 * R4/P0-4：refine 的持久化 enqueue 移入 commit 同事务。buildRefineSideEffects 在
 * dispatcher commit 前生成 side_effect_outbox 行（由 pg-task-repository 在同一事务内
 * INSERT）；snapshot 失败不再静默 return——改为 enqueue snapshotMissing:true 的 refine
 * payload，并额外生成 observer-failure 行留 durable failure。
 *
 * post-commit observer 本体退化为空操作（持久化路径不依赖它）。
 */

import type {
  TaskOutcomeObserverFn,
  TaskOutcomeObserverEvent,
  TaskOutcomeSideEffect,
} from "../../tasking/index.js";

export interface RefineSideEffectDeps {
  kernel: {
    snapshot(): Promise<unknown> | unknown;
  };
  roleId: string;
}

export interface RefineObserverDeps {
  enqueue: (key: string, kind: string, payload: unknown) => Promise<void>;
  kernel: {
    snapshot(): Promise<unknown> | unknown;
  };
  roleId: string;
  logger?: (msg: string) => void;
}

interface RefineTaskContext {
  id?: string;
  title?: string;
  tags?: string[];
  claimed_by?: string | null;
  tenantId?: string;
  payload?: { refine?: string };
}

/**
 * 生成与 task outcome 同事务提交的 refine side-effect（以及 snapshot 失败时的
 * observer-failure durable record）。返回空数组表示不需要 refine。
 */
export async function buildRefineSideEffects(
  deps: RefineSideEffectDeps,
  event: TaskOutcomeObserverEvent,
): Promise<TaskOutcomeSideEffect[]> {
  if (event.outcome.status !== "completed") return [];
  const task = event.context?.["task"];
  if (!task) return [];
  const taskPayload = (task as { payload?: { refine?: string } }).payload;
  if (taskPayload?.refine === "off") return [];
  const taskRecord = task as RefineTaskContext;
  const taskId = taskRecord.id;
  if (!taskId) return [];

  // 租户边界以 work.scope 为准（与 audit/transcript observer 同口径）。
  const tenantId = event.work.scope.tenantId ?? taskRecord.tenantId ?? "default";
  const trace = event.context?.["traceEvents"];
  const artifactRefs = event.outcome.artifacts?.map((a) => a.uri) ?? [];

  // snapshot 必须同步完成（下一任务 reset 会清 context）。R4：失败也入队——带
  // snapshotMissing 标记，另落 observer-failure durable record，不静默丢候选。
  let snapshot: unknown;
  let snapshotMissing = false;
  let snapshotError: string | null = null;
  try {
    snapshot = await deps.kernel.snapshot();
  } catch (e) {
    snapshotMissing = true;
    snapshotError = e instanceof Error ? e.message : String(e);
    snapshot = { variables: [], functions: [], oversized: [] };
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
    snapshotMissing,
  };
  const sideEffects: TaskOutcomeSideEffect[] = [
    { key, tenantId, kind: "refine", payload },
  ];
  if (snapshotMissing) {
    sideEffects.push({
      key: `observer-failure:${tenantId}:${taskId}:${event.lease.generation}:refine-snapshot`,
      tenantId,
      kind: "observer-failure",
      payload: {
        observerName: "refine-observer",
        stage: "snapshot",
        taskId,
        tenantId,
        message: snapshotError ?? "snapshot failed",
        at: new Date().toISOString(),
      },
    });
  }
  return sideEffects;
}

/** @deprecated refine 的持久化 enqueue 已由 buildRefineSideEffects 移入 commit 同事务；保留仅为兼容旧装配。 */
export function createRefineObserver(_deps: RefineObserverDeps): TaskOutcomeObserverFn {
  return async () => {
    // 持久化路径不依赖 post-commit observer；非关键通知暂无可做。
  };
}
