/**
 * PTL Operator Console — debug 页视图模型（纯模块，无 DOM 依赖）。
 *
 * 只读：Worker 快照是权威来源；每 2 秒轮询，5 秒 lagging、15 秒 stale。
 * ActivityHub 事件只作 hint，绝不复活缺失 worker。
 * 序列化面：Working Set 只保留 ID/计数；region 不含 body；
 * 任何序列化输出不得含 prompt / chainOfThought / token / secret / env / 记忆正文。
 */
const FORBIDDEN_KEYS = ["prompt", "chainOfThought", "token", "secret", "env", "content", "memory"];

export const DEBUG_POLL_MS = 2000;
export const DEBUG_LAGGING_MS = 5000;
export const DEBUG_STALE_MS = 15000;

function safeText(v) {
  if (typeof v === "string") return v.slice(0, 1000);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function sanitize(keys, value) {
  const lower = String(keys[keys.length - 1] ?? "").toLowerCase();
  if (FORBIDDEN_KEYS.some((k) => lower.includes(k))) return "[redacted]";
  return value;
}

export function createDebugViewModel({ clock = () => Date.now() } = {}) {
  let workers = [];
  let sourceObservedAt = null;
  let collectedAt = null;
  const filters = { workerId: "", roleId: "", workMode: "all", lifecycle: "all" };

  function freshness(now = clock()) {
    if (sourceObservedAt === null) return "unknown";
    const age = now - collectedAt;
    if (age > DEBUG_STALE_MS) return "stale";
    if (age > DEBUG_LAGGING_MS) return "lagging";
    return "fresh";
  }

  function matches(w) {
    if (filters.workerId && !String(w.workerId ?? "").includes(filters.workerId)) return false;
    if (filters.roleId && w.roleId !== filters.roleId) return false;
    if (filters.workMode !== "all" && w.workMode !== filters.workMode) return false;
    if (filters.lifecycle !== "all" && w.lifecycle !== filters.lifecycle) return false;
    return true;
  }

  function project(w) {
    return {
      workerId: safeText(w.workerId),
      batchId: safeText(w.batchId),
      roleId: safeText(w.roleId),
      roleRevision: safeText(w.roleRevision),
      lifecycle: safeText(w.lifecycle),
      workMode: safeText(w.workMode),
      taskId: safeText(w.taskId),
      leaseId: safeText(w.leaseId),
      heartbeatAt: safeText(w.heartbeatAt),
      regions: Array.isArray(w.regions)
        ? w.regions.map((r) => ({
            regionId: safeText(r?.regionId ?? r?.id),
            weights: typeof r === "object" && r !== null && typeof r.weights === "number" ? r.weights : null,
          }))
        : [],
      workingSet: Array.isArray(w.workingSet)
        ? {
            ids: w.workingSet.map((x) => safeText(x?.id ?? x)).filter(Boolean),
            count: w.workingSet.length,
          }
        : { ids: [], count: 0 },
      toolNames: Array.isArray(w.toolNames) ? w.toolNames.map(safeText).filter(Boolean) : [],
      skillIds: Array.isArray(w.skillIds) ? w.skillIds.map(safeText).filter(Boolean) : [],
    };
  }

  function ingest(nextWorkers, observedAt = clock()) {
    if (!Array.isArray(nextWorkers)) throw new TypeError("debug view: workers must be an array");
    workers = nextWorkers.map((w) => project(w));
    sourceObservedAt = observedAt;
    collectedAt = clock();
    return view();
  }

  function setFilter(key, value) {
    if (!(key in filters)) throw new Error(`unknown filter: ${key}`);
    filters[key] = value;
    return view();
  }

  function view() {
    const now = clock();
    return {
      workers: workers.filter((w) => matches(w)),
      total: workers.length,
      freshness: freshness(now),
      freshnessState: freshness(now),
      sourceObservedAt,
      collectedAt,
      filters: { ...filters },
    };
  }

  function serialize() {
    return JSON.stringify(view(), sanitize);
  }

  return { ingest, setFilter, view, serialize, freshness };
}
