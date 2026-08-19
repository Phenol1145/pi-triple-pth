/**
 * runtime-aggregator.js — N30 Task 4 PTH 运行时区间聚合器。
 *
 * 职责（plan Task 4 / design §6.3 / §6.1）：
 *  - 按 stable ID 键控 PTH timeline interval；
 *  - 只接受更高 sourceVersion；同 sourceVersion 只接受更晚 sourceObservedAt；
 *  - durable snapshot reconcile 是 authoritative：可以纠正丢事件、乱序、重复与晚到终态；
 *  - 窗口内删除使用 tombstone，防止旧 delta 复活已消失区间；
 *  - 每来源 freshness 由显式注入时钟计算，不依赖进程本地时间。
 *
 * 本模块不发起网络请求、不读 token、不接触 Docker Socket。
 */

const DEFAULT_MAX_AGE_MS = 3_600_000;
const DEFAULT_DISCONNECTED_AFTER_MS = 30_000;

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function clone(v) {
  return { ...v };
}

/**
 * 比较 sourceVersion：同为纯数字串时按 BigInt 比较（rowVersion/xmin 可能很大），
 * 否则按字符串排序比较（规范化 updatedAt / ISO timestamp 在固定格式下等价于时间序）。
 */
export function compareSourceVersion(a, b) {
  if (a === b) return 0;
  if (!isNonEmptyString(a) || !isNonEmptyString(b)) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    let an;
    let bn;
    try {
      an = BigInt(a);
      bn = BigInt(b);
    } catch {
      return a < b ? -1 : 1;
    }
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeInterval(raw) {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.id)) return null;
  if (!isNonEmptyString(raw.sourceVersion)) return null;
  if (!isFiniteNumber(raw.startAt)) return null;
  if (raw.endAt !== null && !isFiniteNumber(raw.endAt)) return null;
  return {
    ...raw,
    freshness: isRecord(raw.freshness)
      ? { ...raw.freshness }
      : { sourceObservedAt: raw.startAt, collectedAt: raw.startAt, expectedIntervalMs: 5000, staleAfterMs: 15000 },
  };
}

function computeSourceState(source, now) {
  if (!source) return null;
  const observedAt = isFiniteNumber(source.sourceObservedAt)
    ? source.sourceObservedAt
    : source.lastSuccessAt;
  if (!isFiniteNumber(observedAt)) {
    return { ...source, state: "disconnected" };
  }
  const staleAfterMs = Math.max(
    isFiniteNumber(source.staleAfterMs) ? source.staleAfterMs : 0,
    isFiniteNumber(source.expectedIntervalMs) ? source.expectedIntervalMs : 0,
  );
  const disconnectedAfterMs = Math.max(staleAfterMs, DEFAULT_DISCONNECTED_AFTER_MS);
  const ageMs = now - observedAt;
  let state = "fresh";
  if (ageMs > disconnectedAfterMs) state = "disconnected";
  else if (ageMs > staleAfterMs) state = "stale";
  else if (ageMs > (isFiniteNumber(source.expectedIntervalMs) ? source.expectedIntervalMs : 0)) state = "lagging";
  return { ...source, state };
}

/**
 * @param {object} [options]
 * @param {() => number} [options.clock]
 * @param {number} [options.maxAgeMs] tombstone / 窗口保留上界
 */
export function createRuntimeAggregator({
  clock = () => Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  /** @type {Map<string, Record<string, unknown>>} stable ID → 当前 interval */
  const intervals = new Map();
  /** @type {Map<string, {removedAt: number, sourceVersion: string}>} */
  const tombstones = new Map();
  /** @type {Map<string, Record<string, unknown>>} source → 来源状态 */
  const sources = new Map();
  /** @type {Array<Record<string, unknown>>} 待发事件（由 server 统一分配全局 seq） */
  let pending = [];

  const sourceDefaults = {
    "pth-timeline": { expectedIntervalMs: 5000, staleAfterMs: 15000 },
    "pth-events": { expectedIntervalMs: 2000, staleAfterMs: 5000 },
  };

  function queue(event) {
    pending.push(event);
  }

  function pruneTombstones(now) {
    for (const [id, tomb] of [...tombstones]) {
      if (now - tomb.removedAt > maxAgeMs) tombstones.delete(id);
    }
  }

  function touchSource(source, observedAt, extra = {}) {
    const defaults = sourceDefaults[source] ?? { expectedIntervalMs: 5000, staleAfterMs: 15000 };
    const now = clock();
    sources.set(source, {
      source,
      state: "fresh",
      lastSuccessAt: now,
      lastAttemptAt: now,
      expectedIntervalMs: isFiniteNumber(extra.expectedIntervalMs) ? extra.expectedIntervalMs : defaults.expectedIntervalMs,
      staleAfterMs: isFiniteNumber(extra.staleAfterMs) ? extra.staleAfterMs : defaults.staleAfterMs,
      consecutiveFailures: 0,
      sourceObservedAt: isFiniteNumber(observedAt) ? observedAt : now,
    });
  }

  function recordSourceFailure(source) {
    const defaults = sourceDefaults[source] ?? { expectedIntervalMs: 5000, staleAfterMs: 15000 };
    const now = clock();
    const prev = sources.get(source) ?? {
      source,
      state: "disconnected",
      lastSuccessAt: null,
      sourceObservedAt: null,
      expectedIntervalMs: defaults.expectedIntervalMs,
      staleAfterMs: defaults.staleAfterMs,
      consecutiveFailures: 0,
    };
    const next = {
      ...prev,
      source,
      lastAttemptAt: now,
      consecutiveFailures: (prev.consecutiveFailures ?? 0) + 1,
    };
    sources.set(source, next);
    return computeSourceState(next, now);
  }

  function reconcileSnapshot(snapshot) {
    if (!isRecord(snapshot)) {
      return { accepted: false, reason: "snapshot must be an object" };
    }
    const now = clock();
    const incoming = Array.isArray(snapshot.intervals) ? snapshot.intervals : [];
    const next = new Map();

    for (const raw of incoming) {
      const iv = normalizeInterval(raw);
      if (!iv) continue;
      next.set(iv.id, iv);
    }

    // 窗口内删除：snapshot 中消失的 stable ID 不立即遗忘，而是 tombstone，
    // 防止旧 delta 在窗口内复活；同时产生 interval.remove 供浏览器移除。
    for (const [id, prev] of [...intervals]) {
      if (!next.has(id)) {
        intervals.delete(id);
        tombstones.set(id, {
          removedAt: now,
          sourceVersion: String(prev.sourceVersion ?? ""),
        });
        queue({
          type: "interval.remove",
          payload: { id, source: "pth-timeline", removedAt: now },
        });
      }
    }

    // durable snapshot 是 authoritative：逐条覆盖本地派生状态。
    for (const [id, iv] of next) {
      const prev = intervals.get(id);
      const changed = !prev
        || prev.sourceVersion !== iv.sourceVersion
        || prev.status !== iv.status
        || prev.endAt !== iv.endAt
        || prev.startAt !== iv.startAt;
      intervals.set(id, clone(iv));
      tombstones.delete(id);
      if (changed) {
        queue({ type: "interval.upsert", payload: clone(iv) });
      }
    }

    // snapshot 成功 = pth-timeline 来源一次成功观测。
    const sourceObservedAt = isFiniteNumber(snapshot.collectedAt) ? snapshot.collectedAt : now;
    touchSource("pth-timeline", sourceObservedAt);

    pruneTombstones(now);
    return { accepted: true, snapshotId: snapshot.snapshotId ?? null, intervalCount: next.size };
  }

  function applyDelta(delta) {
    if (!isRecord(delta)) {
      return { accepted: false, reason: "delta must be an object" };
    }

    if (delta.type === "snapshot") {
      return reconcileSnapshot(delta.payload);
    }

    if (delta.type === "interval.upsert") {
      const iv = normalizeInterval(delta.payload);
      if (!iv) {
        return { accepted: false, reason: "invalid interval payload" };
      }

      const existing = intervals.get(iv.id);
      const tomb = tombstones.get(iv.id);

      if (tomb) {
        const cmp = compareSourceVersion(iv.sourceVersion, tomb.sourceVersion);
        if (cmp <= 0) {
          return { accepted: false, reason: "interval tombstoned: stale revision" };
        }
        tombstones.delete(iv.id);
        intervals.set(iv.id, clone(iv));
        queue({ type: "interval.upsert", payload: clone(iv) });
        return { accepted: true, id: iv.id };
      }

      if (!existing) {
        intervals.set(iv.id, clone(iv));
        queue({ type: "interval.upsert", payload: clone(iv) });
        return { accepted: true, id: iv.id };
      }

      const cmp = compareSourceVersion(iv.sourceVersion, existing.sourceVersion);
      if (cmp > 0) {
        intervals.set(iv.id, clone(iv));
        queue({ type: "interval.upsert", payload: clone(iv) });
        return { accepted: true, id: iv.id };
      }
      if (cmp === 0) {
        const existingObservedAt = existing.freshness?.sourceObservedAt;
        const incomingObservedAt = iv.freshness?.sourceObservedAt;
        if (isFiniteNumber(incomingObservedAt) && isFiniteNumber(existingObservedAt)
          && incomingObservedAt > existingObservedAt) {
          intervals.set(iv.id, clone(iv));
          queue({ type: "interval.upsert", payload: clone(iv) });
          return { accepted: true, id: iv.id };
        }
        return { accepted: false, reason: "duplicate or out-of-order delta" };
      }
      return { accepted: false, reason: "stale revision" };
    }

    if (delta.type === "heartbeat") {
      const payload = isRecord(delta.payload) ? delta.payload : {};
      const source = payload.source === "pth-events" ? "pth-events" : "pth-timeline";
      const sourceObservedAt = isFiniteNumber(payload.freshness?.sourceObservedAt)
        ? payload.freshness.sourceObservedAt
        : clock();
      touchSource(source, sourceObservedAt, payload.freshness ?? {});
      return { accepted: true, source };
    }

    if (delta.type === "warning.upsert") {
      // 本任务只做只读提示透传，不做告警评估（Task 6）。
      queue({ type: "warning.upsert", payload: clone(delta.payload) });
      return { accepted: true };
    }

    return { accepted: false, reason: `unsupported delta type: ${String(delta.type)}` };
  }

  return {
    reconcileSnapshot,
    applyDelta,

    /** 当前有效区间（稳定 ID 去重，每 ID 至多一条）。 */
    getIntervals() {
      return [...intervals.values()].map(clone);
    },

    /** 取出并清空待发事件；事件不含全局 seq，由 server 统一分配。 */
    drainEvents() {
      const events = pending;
      pending = [];
      return events;
    },

    /** 当前各来源状态（已按注入时钟计算 fresh/lagging/stale/disconnected）。 */
    getSources() {
      const now = clock();
      return [...sources.values()]
        .map((source) => computeSourceState(source, now))
        .filter(Boolean);
    },

    markSourceSuccess(source, observedAt, extra) {
      touchSource(source, observedAt, extra);
    },

    markSourceFailure(source) {
      return recordSourceFailure(source);
    },
  };
}
