import type { TaskStore } from "@away_from/pth-kernel-storage";

export interface LoadStats {
  pendingCount: number;
  idleRatio: number;
  batchCount: number;
  collectedAt: number;
}

export interface BatchStatusLike {
  id: string;
  workers: string[];
  currentTasks: Record<string, string>;   // workerId → taskId
}

export interface BatchSuggestion {
  action: "add" | "remove" | "keep";
  reason: string;
  data: { pendingCount: number; idleRatio: number; batchCount: number };
}

export async function collectStats(deps: {
  taskStore: Pick<TaskStore, "countPending">;
  batches: BatchStatusLike[];
}): Promise<LoadStats> {
  const pendingCount = await deps.taskStore.countPending();
  const totalWorkers = deps.batches.reduce((sum, b) => sum + b.workers.length, 0);
  const busyWorkers = deps.batches.reduce((sum, b) => sum + Object.keys(b.currentTasks).length, 0);
  const idleRatio = totalWorkers === 0 ? 1 : (totalWorkers - busyWorkers) / totalWorkers;
  return { pendingCount, idleRatio, batchCount: deps.batches.length, collectedAt: Date.now() };
}

/** v1 简单规则（Spec B §8）：阈值可配置（env/配置）；v2 统计优化器自适应 */
export function suggest(stats: LoadStats): BatchSuggestion {
  const { pendingCount, idleRatio, batchCount } = stats;
  if (pendingCount > 10 && idleRatio < 0.3) {
    return { action: "add", reason: "任务积压且 worker 忙", data: { pendingCount, idleRatio, batchCount } };
  }
  if (idleRatio > 0.7 && batchCount > 1) {
    return { action: "remove", reason: "普遍空闲且多 batch", data: { pendingCount, idleRatio, batchCount } };
  }
  return { action: "keep", reason: "负载均衡", data: { pendingCount, idleRatio, batchCount } };
}
