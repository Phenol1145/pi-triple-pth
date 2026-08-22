/**
 * web-src/src/view-models/debug.ts — Operator Console debug 页视图模型（纯 TS，无 DOM）。
 *
 * 从 legacy web/operator-console/debug.js 迁移；只读 Worker 快照投影。
 */

const FORBIDDEN_KEYS = ["prompt", "chainOfThought", "token", "secret", "env", "content", "memory"];

export const DEBUG_POLL_MS = 2000;
export const DEBUG_LAGGING_MS = 5000;
export const DEBUG_STALE_MS = 15000;

export interface DebugRegion {
  regionId: string | null;
  weights: number | null;
}

export interface DebugWorkingSet {
  ids: Array<string | number | null>;
  count: number;
}

export interface DebugWorker {
  workerId: string | null;
  batchId: string | null;
  roleId: string | null;
  roleRevision: string | null;
  lifecycle: string | null;
  workMode: string | null;
  taskId: string | null;
  leaseId: string | null;
  heartbeatAt: string | null;
  regions: DebugRegion[];
  workingSet: DebugWorkingSet;
  toolNames: Array<string | number | null>;
  skillIds: Array<string | number | null>;
}

export interface DebugFilters {
  workerId: string;
  roleId: string;
  workMode: string;
  lifecycle: string;
}

export interface DebugView {
  workers: DebugWorker[];
  total: number;
  freshness: "unknown" | "fresh" | "lagging" | "stale";
  freshnessState: "unknown" | "fresh" | "lagging" | "stale";
  sourceObservedAt: number | null;
  collectedAt: number | null;
  filters: DebugFilters;
}

function safeText(value: unknown): string | number | null {
  if (typeof value === "string") return value.slice(0, 1000);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function sanitize(key: string, value: unknown): unknown {
  if (FORBIDDEN_KEYS.some((forbidden) => key.toLowerCase().includes(forbidden))) return "[redacted]";
  return value;
}

export function createDebugViewModel({ clock = () => Date.now() }: { clock?: () => number } = {}) {
  let workers: DebugWorker[] = [];
  let sourceObservedAt: number | null = null;
  let collectedAt: number | null = null;
  const filters: DebugFilters = { workerId: "", roleId: "", workMode: "all", lifecycle: "all" };

  function freshness(now: number = clock()): DebugView["freshness"] {
    if (sourceObservedAt === null) return "unknown";
    const age = now - (collectedAt ?? now);
    if (age > DEBUG_STALE_MS) return "stale";
    if (age > DEBUG_LAGGING_MS) return "lagging";
    return "fresh";
  }

  function matches(worker: DebugWorker): boolean {
    if (filters.workerId && !String(worker.workerId ?? "").includes(filters.workerId)) return false;
    if (filters.roleId && worker.roleId !== filters.roleId) return false;
    if (filters.workMode !== "all" && worker.workMode !== filters.workMode) return false;
    if (filters.lifecycle !== "all" && worker.lifecycle !== filters.lifecycle) return false;
    return true;
  }

  function project(worker: Record<string, any>): DebugWorker {
    return {
      workerId: safeText(worker.workerId) as string | null,
      batchId: safeText(worker.batchId) as string | null,
      roleId: safeText(worker.roleId) as string | null,
      roleRevision: safeText(worker.roleRevision) as string | null,
      lifecycle: safeText(worker.lifecycle) as string | null,
      workMode: safeText(worker.workMode) as string | null,
      taskId: safeText(worker.taskId) as string | null,
      leaseId: safeText(worker.leaseId) as string | null,
      heartbeatAt: safeText(worker.heartbeatAt) as string | null,
      regions: Array.isArray(worker.regions)
        ? worker.regions.map((region: Record<string, any>) => ({
            regionId: safeText(region?.regionId ?? region?.id) as string | null,
            weights: typeof region === "object" && region !== null && typeof region.weights === "number" ? region.weights : null,
          }))
        : [],
      workingSet: Array.isArray(worker.workingSet)
        ? {
            ids: worker.workingSet.map((entry: unknown) => safeText((entry as Record<string, any>)?.id ?? entry)).filter(Boolean),
            count: worker.workingSet.length,
          }
        : { ids: [], count: 0 },
      toolNames: Array.isArray(worker.toolNames) ? worker.toolNames.map(safeText).filter(Boolean) : [],
      skillIds: Array.isArray(worker.skillIds) ? worker.skillIds.map(safeText).filter(Boolean) : [],
    };
  }

  function ingest(nextWorkers: unknown, observedAt: number = clock()): DebugView {
    if (!Array.isArray(nextWorkers)) throw new TypeError("debug view: workers must be an array");
    workers = nextWorkers.map((worker) => project(worker as Record<string, any>));
    sourceObservedAt = observedAt;
    collectedAt = clock();
    return view();
  }

  function setFilter(key: keyof DebugFilters, value: string): DebugView {
    if (!(key in filters)) throw new Error(`unknown filter: ${key}`);
    filters[key] = value;
    return view();
  }

  function view(): DebugView {
    const now = clock();
    return {
      workers: workers.filter((worker) => matches(worker)),
      total: workers.length,
      freshness: freshness(now),
      freshnessState: freshness(now),
      sourceObservedAt,
      collectedAt,
      filters: { ...filters },
    };
  }

  function serialize(): string {
    return JSON.stringify(view(), sanitize);
  }

  return { ingest, setFilter, view, serialize, freshness };
}
