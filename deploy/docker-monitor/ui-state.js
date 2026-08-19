/**
 * ui-state.js — N30 Task 5 纯 UI 状态模型（无 DOM 依赖）。
 *
 * 职责（plan Task 5 Step 1 / design §7）：
 *  - 维护一个共享 windowStart/windowEnd 对象，甘特图与资源图读同一引用；
 *  - 15m/1h/custom 时间窗、intake/optimize/run 正交过滤；
 *  - pause/resume、选中区间、Job→Task→Intake/Optimize/Professional Stage 层级折叠；
 *  - 事件 replay（snapshot/interval.upsert/interval.remove/freshness/heartbeat
 *    以及兼容 resource-sample/service-interval）；
 *  - 按 renderedAt 计算每个来源的 fresh/lagging/stale/disconnected 状态并暴露 stale 区间。
 *
 * 本模块不接触 DOM、不发网络请求、不读凭据、不接触宿主机 Docker 套接字。
 */

const PRESET_MS = {
  "15m": 900_000,
  "1h": 3_600_000,
};

const KIND_ORDER = {
  job: 0,
  task: 1,
  "professional-job": 2,
  "intake-run": 2,
  "optimizer-work": 2,
  "intake-stage": 3,
  // 服务 lane 放在业务层级下方（plan Task 5 Step 3）。
  service: 99,
};

const DEFAULT_DISCONNECTED_AFTER_MS = 30_000;

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function clone(v) {
  return { ...v };
}

/**
 * 比较 sourceVersion：数字串按 BigInt 比较，其余按字符串序比较。
 */
function compareSourceVersion(a, b) {
  if (a === b) return 0;
  const aNumeric = typeof a === "string" && /^\d+$/.test(a);
  const bNumeric = typeof b === "string" && /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    let an;
    let bn;
    try {
      an = BigInt(a);
      bn = BigInt(b);
    } catch {
      return String(a) < String(b) ? -1 : 1;
    }
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function normalizeInterval(raw) {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  if (!isFiniteNumber(raw.startAt)) return null;
  if (raw.endAt !== null && raw.endAt !== undefined && !isFiniteNumber(raw.endAt)) return null;
  return {
    ...raw,
    freshness: isRecord(raw.freshness)
      ? { ...raw.freshness }
      : {
          sourceObservedAt: raw.startAt,
          collectedAt: raw.startAt,
          expectedIntervalMs: 5000,
          staleAfterMs: 15000,
        },
  };
}

function computeSourceState(source, renderedAt) {
  if (!isRecord(source)) return { source: "unknown", state: "disconnected" };
  const observedAt = isFiniteNumber(source.sourceObservedAt)
    ? source.sourceObservedAt
    : isFiniteNumber(source.lastSuccessAt)
      ? source.lastSuccessAt
      : null;
  const expectedIntervalMs = isFiniteNumber(source.expectedIntervalMs)
    ? source.expectedIntervalMs
    : 0;
  const staleAfterMs = Math.max(
    isFiniteNumber(source.staleAfterMs) ? source.staleAfterMs : 0,
    expectedIntervalMs,
  );
  const disconnectedAfterMs = Math.max(staleAfterMs, DEFAULT_DISCONNECTED_AFTER_MS);

  if (!isFiniteNumber(observedAt)) {
    return { ...source, state: "disconnected" };
  }
  const ageMs = Math.max(0, renderedAt - observedAt);
  let state = "fresh";
  if (ageMs > disconnectedAfterMs) state = "disconnected";
  else if (ageMs > staleAfterMs) state = "stale";
  else if (ageMs > expectedIntervalMs) state = "lagging";
  return { ...source, state };
}

function sourceForInterval(iv) {
  return iv.kind === "service" ? "docker" : "pth-timeline";
}

function intervalFreshnessAgeMs(iv, renderedAt) {
  const f = iv.freshness;
  if (!isRecord(f)) return null;
  const observedAt = isFiniteNumber(f.sourceObservedAt) ? f.sourceObservedAt : f.collectedAt;
  if (!isFiniteNumber(observedAt)) return null;
  return renderedAt - observedAt;
}

function sampleKey(s) {
  return `${s.source ?? "?"}|${s.targetKind ?? "?"}|${s.targetId ?? "?"}|${s.ts}`;
}

/**
 * N30 Task 5 Step 5：embed 模式的 base 校验。
 * 只允许同源绝对路径：必须以单 / 开头，不得包含 scheme、host、..、编码斜杠、反斜杠或查询片段。
 * 返回归一化 base（去掉尾部 /），非法时返回 null。
 */
export function validateEmbedBase(base) {
  if (typeof base !== "string") return null;
  if (base === "" || base === "/") return "/";
  if (!base.startsWith("/")) return null;
  if (base.startsWith("//")) return null;
  if (base.includes("..")) return null;
  if (base.includes("\\")) return null;
  if (base.includes("?") || base.includes("#")) return null;
  if (/%2f/i.test(base)) return null;
  if (/%5c/i.test(base)) return null;
  if (/%2e/i.test(base)) return null;
  return base.replace(/\/+$/, "") || "/";
}

/**
 * @param {object} [options]
 * @param {() => number} [options.clock]
 * @param {object|null} [options.initialSnapshot]
 * @param {"15m"|"1h"} [options.defaultPreset]
 * @param {number} [options.maxSamples] UI 端资源样本有界保留上限。
 */
export function createUiState({
  clock = () => Date.now(),
  initialSnapshot = null,
  defaultPreset = "1h",
  maxSamples = 8000,
} = {}) {
  if (!Object.prototype.hasOwnProperty.call(PRESET_MS, defaultPreset)) {
    throw new TypeError(`createUiState: unsupported defaultPreset ${String(defaultPreset)}`);
  }

  /** 共享窗口对象：甘特图与资源图必须读取同一引用。 */
  const window = { from: 0, to: 0 };

  let preset = defaultPreset;
  let paused = false;
  let selectedIntervalId = null;
  /** @type {Set<string>} 被折叠的 interval id（其子孙不出现在甘特 lane 中）。 */
  const collapsed = new Set();
  /** @type {Set<string>} workMode 过滤（空 = 全部）。 */
  const workModeFilter = new Set();

  /** @type {Map<string, Record<string, unknown>>} stable ID → interval */
  const intervals = new Map();
  /** @type {Map<string, number>} 样本去重 key → 样本数组下标 */
  const sampleIndex = new Map();
  /** @type {Array<Record<string, unknown>>} 按 ts 递增的样本 */
  let samples = [];
  /** @type {Array<Record<string, unknown>>} */
  let sources = [];
  /** @type {Array<Record<string, unknown>>} */
  let warnings = [];
  /** @type {Record<string, unknown>} */
  let summary = {};
  /** @type {Record<string, unknown>} */
  let scope = { mode: "local-admin", tenantId: "local" };
  let snapshotId = null;
  let streamEpoch = null;
  let lastSeq = null;
  let refetchRequired = false;

  function now() {
    return clock();
  }

  function setWindow(from, to) {
    if (!isFiniteNumber(from) || !isFiniteNumber(to) || from >= to) {
      throw new RangeError(`ui-state: invalid window [${from}, ${to}]`);
    }
    window.from = from;
    window.to = to;
  }

  function setLiveWindow(nowMs = now()) {
    setWindow(nowMs - PRESET_MS[preset], nowMs);
  }

  setLiveWindow();

  function pushSample(raw) {
    if (!isRecord(raw) || !isFiniteNumber(raw.ts)) return false;
    const key = sampleKey(raw);
    const existingIdx = sampleIndex.get(key);
    const sample = { ...raw };
    if (existingIdx !== undefined) {
      samples[existingIdx] = sample;
      return false;
    }
    sampleIndex.set(key, samples.length);
    samples.push(sample);
    while (samples.length > maxSamples) {
      const dropped = samples.shift();
      sampleIndex.delete(sampleKey(dropped));
      for (const [k, idx] of [...sampleIndex]) {
        if (idx > 0) sampleIndex.set(k, idx - 1);
      }
    }
    return true;
  }

  function applySnapshot(snapshot) {
    if (!isRecord(snapshot)) return;

    const nextIntervals = new Map();
    const incoming = Array.isArray(snapshot.intervals) ? snapshot.intervals : [];
    for (const raw of incoming) {
      const iv = normalizeInterval(raw);
      if (iv) nextIntervals.set(iv.id, iv);
    }
    intervals.clear();
    for (const [id, iv] of nextIntervals) intervals.set(id, iv);

    // 资源样本：服务端字段名可能为 samples（docker-monitor）或 resources（design DTO）。
    sampleIndex.clear();
    samples = [];
    const incomingSamples = Array.isArray(snapshot.samples)
      ? snapshot.samples
      : Array.isArray(snapshot.resources)
        ? snapshot.resources
        : [];
    for (const raw of incomingSamples) {
      pushSample(raw);
    }

    sources = Array.isArray(snapshot.sources) ? snapshot.sources.map(clone) : [];
    warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings.map(clone) : [];
    summary = isRecord(snapshot.summary) ? { ...snapshot.summary } : {};
    scope = isRecord(snapshot.scope) ? { ...snapshot.scope } : scope;
    snapshotId = typeof snapshot.snapshotId === "string" ? snapshot.snapshotId : snapshotId;
    if (typeof snapshot.streamEpoch === "string") streamEpoch = snapshot.streamEpoch;

    const collectedAt = isFiniteNumber(snapshot.collectedAt) ? snapshot.collectedAt : now();
    if (!paused && preset !== "custom") {
      setWindow(collectedAt - PRESET_MS[preset], collectedAt);
    }
    refetchRequired = false;
  }

  function applyEvent(ev) {
    if (!isRecord(ev)) return { applied: false };
    const type = ev.type ?? ev.event;
    const payload = isRecord(ev.payload)
      ? ev.payload
      : typeof ev.data === "string"
        ? (() => {
            try {
              return JSON.parse(ev.data);
            } catch {
              return null;
            }
          })()
        : ev.data;

    // seq / epoch 跟踪：缺口或换 epoch 必须触发 snapshot 重取，但不丢弃当前事件。
    const seq = isFiniteNumber(ev.seq) ? ev.seq : isFiniteNumber(ev.id) ? Number(ev.id) : null;
    if (seq !== null) {
      if (lastSeq !== null && seq > lastSeq + 1) refetchRequired = true;
      lastSeq = seq;
    }
    const incomingEpoch = typeof ev.streamEpoch === "string" ? ev.streamEpoch : null;
    if (incomingEpoch !== null && streamEpoch !== null && incomingEpoch !== streamEpoch) {
      refetchRequired = true;
    }
    if (incomingEpoch !== null) streamEpoch = incomingEpoch;

    if (type === "snapshot") {
      applySnapshot(payload);
      return { applied: true, type };
    }

    if (type === "interval.upsert" || type === "service-interval") {
      const iv = normalizeInterval(payload);
      if (!iv) return { applied: false, type };
      const existing = intervals.get(iv.id);
      if (existing) {
        const cmp = compareSourceVersion(iv.sourceVersion, existing.sourceVersion);
        if (cmp < 0) return { applied: false, type, reason: "stale revision" };
        if (cmp === 0) {
          const incomingObserved = iv.freshness?.sourceObservedAt;
          const existingObserved = existing.freshness?.sourceObservedAt;
          if (
            isFiniteNumber(incomingObserved)
            && isFiniteNumber(existingObserved)
            && incomingObserved <= existingObserved
          ) {
            return { applied: false, type, reason: "duplicate or out-of-order" };
          }
        }
      }
      intervals.set(iv.id, iv);
      return { applied: true, type };
    }

    if (type === "interval.remove") {
      if (isRecord(payload) && typeof payload.id === "string") {
        intervals.delete(payload.id);
        if (selectedIntervalId === payload.id) selectedIntervalId = null;
        collapsed.delete(payload.id);
        return { applied: true, type };
      }
      return { applied: false, type };
    }

    if (type === "resource-sample") {
      return { applied: pushSample(payload), type };
    }

    if (type === "freshness") {
      if (isRecord(payload) && Array.isArray(payload.sources)) {
        sources = payload.sources.map(clone);
      }
      return { applied: true, type };
    }

    if (type === "heartbeat") {
      if (isRecord(payload)) {
        const source = payload.source === "pth-events" ? "pth-events" : "aggregator";
        const idx = sources.findIndex((s) => s.source === source);
        const observedAt = isFiniteNumber(payload.freshness?.sourceObservedAt)
          ? payload.freshness.sourceObservedAt
          : now();
        const freshness = isRecord(payload.freshness) ? { ...payload.freshness } : {};
        const next = {
          ...(idx >= 0 ? sources[idx] : { source }),
          source,
          lastSuccessAt: isFiniteNumber(payload.freshness?.sourceObservedAt)
            ? payload.freshness.sourceObservedAt
            : now(),
          lastAttemptAt: now(),
          consecutiveFailures: 0,
          expectedIntervalMs: isFiniteNumber(freshness.expectedIntervalMs)
            ? freshness.expectedIntervalMs
            : idx >= 0 && isFiniteNumber(sources[idx].expectedIntervalMs)
              ? sources[idx].expectedIntervalMs
              : 2000,
          staleAfterMs: isFiniteNumber(freshness.staleAfterMs)
            ? freshness.staleAfterMs
            : idx >= 0 && isFiniteNumber(sources[idx].staleAfterMs)
              ? sources[idx].staleAfterMs
              : 6000,
          sourceObservedAt: observedAt,
        };
        if (idx >= 0) sources[idx] = next;
        else sources.push(next);
      }
      return { applied: true, type };
    }

    if (type === "warning.upsert") {
      if (isRecord(payload)) {
        const exists = warnings.some(
          (w) => w.code === payload.code && w.source === payload.source && w.message === payload.message,
        );
        if (!exists) warnings.push(clone(payload));
      }
      return { applied: true, type };
    }

    return { applied: false, type };
  }

  function getVisibleIntervals() {
    const result = [];
    for (const iv of intervals.values()) {
      const endAt = iv.endAt;
      const overlapsWindow = iv.startAt <= window.to && (endAt === null || endAt === undefined || endAt >= window.from);
      if (!overlapsWindow) continue;

      if (workModeFilter.size > 0) {
        if (iv.kind !== "service") {
          const wm = iv.workMode;
          if (typeof wm !== "string" || !workModeFilter.has(wm)) continue;
        }
      }
      result.push(iv);
    }
    return result;
  }

  function getGanttLanes() {
    const visible = getVisibleIntervals();
    const byId = new Map(visible.map((iv) => [iv.id, iv]));

    function hasVisibleChild(id) {
      for (const iv of visible) {
        if (iv.parentId === id && byId.has(iv.id)) return true;
      }
      return false;
    }

    function isHiddenByCollapsedAncestor(id) {
      let current = byId.get(id);
      let guard = 0;
      while (current && guard < 64) {
        if (current.parentId && collapsed.has(current.parentId)) return true;
        current = byId.get(current.parentId);
        guard += 1;
      }
      return false;
    }

    function depthOf(id) {
      let depth = 0;
      let current = byId.get(id);
      let guard = 0;
      while (current && current.parentId && guard < 64) {
        depth += 1;
        current = byId.get(current.parentId);
        guard += 1;
      }
      return depth;
    }

    const lanes = [];
    for (const iv of visible) {
      if (isHiddenByCollapsedAncestor(iv.id)) continue;
      lanes.push({
        id: iv.id,
        kind: iv.kind,
        label: typeof iv.label === "string" ? iv.label : iv.id,
        depth: depthOf(iv.id),
        interval: iv,
        workMode: iv.workMode,
        status: iv.status,
        startAt: iv.startAt,
        endAt: iv.endAt,
        hasChildren: hasVisibleChild(iv.id),
        collapsed: collapsed.has(iv.id),
      });
    }
    lanes.sort((a, b) => {
      const ka = KIND_ORDER[a.kind] ?? 9;
      const kb = KIND_ORDER[b.kind] ?? 9;
      if (ka !== kb) return ka - kb;
      if (a.startAt !== b.startAt) return a.startAt - b.startAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return lanes;
  }

  function getSourceStates(renderedAt) {
    return sources.map((s) => computeSourceState(s, renderedAt));
  }

  function getStaleIntervals(renderedAt) {
    const states = getSourceStates(renderedAt);
    const staleSources = new Set(
      states
        .filter((s) => s.state === "stale" || s.state === "disconnected")
        .map((s) => s.source),
    );
    const result = [];
    for (const iv of intervals.values()) {
      const src = sourceForInterval(iv);
      if (staleSources.has(src)) {
        result.push(iv);
        continue;
      }
      const age = intervalFreshnessAgeMs(iv, renderedAt);
      const staleAfterMs = iv.freshness?.staleAfterMs;
      if (isFiniteNumber(age) && isFiniteNumber(staleAfterMs) && age > staleAfterMs) {
        result.push(iv);
      }
    }
    return result;
  }

  function getSamples() {
    return [...samples].sort((a, b) => a.ts - b.ts);
  }

  function getVisibleSamples() {
    return getSamples().filter((s) => s.ts >= window.from && s.ts <= window.to);
  }

  return {
    getWindow: () => window,
    getPreset: () => preset,

    setPreset(next) {
      if (!Object.prototype.hasOwnProperty.call(PRESET_MS, next)) {
        throw new TypeError(`ui-state: unsupported preset ${String(next)}`);
      }
      preset = next;
      setLiveWindow();
    },

    setCustomWindow(from, to) {
      setWindow(from, to);
      preset = "custom";
    },

    zoomFromBrush(from, to) {
      setWindow(from, to);
      preset = "custom";
    },

    setPaused(next) {
      const was = paused;
      paused = Boolean(next);
      if (was && !paused) refetchRequired = true;
    },

    isPaused: () => paused,

    resume() {
      paused = false;
      refetchRequired = true;
      if (preset !== "custom") setLiveWindow();
    },

    isRefetchRequired: () => refetchRequired,

    applySnapshot,
    applyEvent,

    selectInterval(id) {
      selectedIntervalId = typeof id === "string" ? id : null;
    },

    clearSelection() {
      selectedIntervalId = null;
    },

    getSelectedIntervalId: () => selectedIntervalId,

    getSelectedInterval: () => {
      if (selectedIntervalId === null) return null;
      return intervals.get(selectedIntervalId) ?? null;
    },

    toggleCollapse(id) {
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
    },

    isCollapsed: (id) => collapsed.has(id),
    getCollapsed: () => new Set(collapsed),

    setWorkModeFilter(items) {
      workModeFilter.clear();
      for (const item of items ?? []) {
        if (item === "intake" || item === "optimize" || item === "run") {
          workModeFilter.add(item);
        }
      }
    },

    getWorkModeFilter: () => new Set(workModeFilter),

    getIntervals: () => [...intervals.values()].map(clone),
    getVisibleIntervals,
    getGanttLanes,
    getSamples,
    getVisibleSamples,
    getSources: () => sources.map(clone),
    getSourceStates,
    getStaleIntervals,
    getSummary: () => ({ ...summary }),
    getWarnings: () => warnings.map(clone),
    getSnapshotId: () => snapshotId,
    getScope: () => ({ ...scope }),
  };
}
