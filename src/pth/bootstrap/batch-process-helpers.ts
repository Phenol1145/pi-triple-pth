/**
 * batch-process-helpers.ts —— BatchTaskLoop 与 batch 装配辅助函数（Phase D D4 拆分）。
 */

import { TaskLoop, type TaskLoopDeps } from "./task-loop.js";
import type { ArchiveDeps } from "@away_from/pth-kernel-execution";
import { archiveTask } from "@away_from/pth-kernel-execution";
import type { Task } from "@away_from/pth-kernel-storage";
import type { InterpreterResult } from "@away_from/pth-kernel-interpreter";
import { DISCIPLINE_DEFINITIONS, DisciplineCatalogBuilder, type DisciplineCatalogSnapshot } from "../catalog/index.js";
import { createDisciplineResolver } from "../catalog/index.js";
import type { RefineInput } from "@away_from/pth-kernel-execution";

export class BatchTaskLoop {
  private inner: TaskLoop;

  constructor(deps: TaskLoopDeps, archiveDeps: ArchiveDeps) {
    this.inner = new TaskLoop({
      ...deps,
      archiveFn: async (task: Task, ws: { dir: string; tenant: string }, result: unknown) => {
        await archiveTask(task, ws, result as InterpreterResult, archiveDeps);
      },
    });
  }

  runOnce(): Promise<boolean> { return this.inner.runOnce(); }
  pause(): void { this.inner.pause(); }
  resume(): void { this.inner.resume(); }
  stop(): void { this.inner.stop(); }
  get isPaused(): boolean { return this.inner.isPaused; }
  get isStopped(): boolean { return this.inner.isStopped; }
}

/** K2 Phase 2：从同一份生成数据构建 catalog 快照（与 assembly 同源同版本）。 */
export function buildDisciplineCatalogSnapshot(): DisciplineCatalogSnapshot {
  const builder = new DisciplineCatalogBuilder();
  for (const def of DISCIPLINE_DEFINITIONS) builder.add(def);
  return builder.build();
}

/** K2 Phase 2：从同一份生成数据构建 catalog 快照 + resolver（与 assembly 同源同版本）。 */
export function buildDisciplineResolver(): ReturnType<typeof createDisciplineResolver> {
  return createDisciplineResolver(buildDisciplineCatalogSnapshot());
}

/** F5：outbox payload → RefineInput 重建（payload 不存大 trace——traceEvents 已截断 60 条；
 *  snapshot 可省略——缺失回退空快照，refiner.refine 输入保持现有形状）。 */
export function refineInputFromPayload(payload: unknown): RefineInput {
  const p = (payload ?? {}) as Record<string, unknown>;
  const taskFromPayload = p.task as RefineInput["task"] | undefined;
  const roleId = typeof p.roleId === "string" ? p.roleId : undefined;
  const taskId = taskFromPayload?.id ?? (typeof p.taskId === "string" ? p.taskId : "unknown");
  const domains = Array.isArray(p.domains) ? (p.domains as string[]) : undefined;
  const domainBinding = (p.domainBinding && typeof p.domainBinding === "object")
    ? (p.domainBinding as RefineInput["domainBinding"])
    : undefined;
  const outcome = (p.outcome && typeof p.outcome === "object")
    ? (p.outcome as RefineInput["outcome"])
    : undefined;
  const artifactRefs = Array.isArray(p.artifactRefs) ? (p.artifactRefs as string[]) : undefined;
  return {
    task: taskFromPayload ?? {
      id: taskId,
      title: typeof p.taskTitle === "string" ? p.taskTitle : "",
      tags: Array.isArray(p.tags) ? (p.tags as string[]) : [],
      claimed_by: roleId ?? null,
    },
    snapshot: (p.snapshot ?? { variables: [], functions: [], oversized: [] }) as RefineInput["snapshot"],
    scope: { tenantId: typeof p.tenantId === "string" ? p.tenantId : "default", space: "meta" },
    trace: Array.isArray(p.traceEvents) ? (p.traceEvents as unknown[]).slice(0, 60) as RefineInput["trace"] : undefined,
    role: roleId,
    ...(domains ? { domains } : {}),
    ...(domainBinding ? { domainBinding } : {}),
    ...(outcome ? { outcome } : {}),
    ...(artifactRefs ? { artifactRefs } : {}),
  };
}

/**
 * batch 子进程主函数（方案 C，裁决 15）：pth 主进程 fork 本文件。
 * 自驱动：轮询 taskStore → 全角色 worker 各跑 TaskLoop.runOnce。
 * IPC：收 shutdown → 立即退出；收 pause/resume → 暂停/恢复认领。
 * 不 resolve：子进程长驻（pg 连接池维持存活），主进程通过 IPC 终止。
 */
