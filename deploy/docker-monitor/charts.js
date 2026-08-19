/**
 * charts.js — N30 Task 5 纯渲染模型与 SVG/Canvas 绘制（无框架、无 CDN、无 DOM 依赖）。
 *
 * 职责（plan Task 5 Step 3/4 / design §7）：
 *  - buildGanttModel / renderGanttSvg：Job → Task → Intake/Optimize/Professional Stage
 *    分层甘特 + service lane；状态色固定，Work Mode 使用独立图形标记；
 *  - buildResourceModel / drawResourceChart：CPU/RSS/Heap/Network 共享同一 x 轴，
 *    null 样本段画缺口不连线，stale 段画半透明着色遮罩；
 *  - buildDetailModel：选中区间的 Worker/Role/Batch/Trace/重试/错误/资源窗口摘要；
 *  - renderTextSummary：无指针访问的文本摘要。
 *
 * 本模块不读凭据、不接触宿主机 Docker 套接字、不发起网络请求。
 */

const STALE_SHADE = "rgba(110,118,129,0.25)";

export const STATUS_COLORS = {
  queued: "#8b949e",
  running: "#22d3ee",
  waiting: "#d29922",
  retrying: "#f0883e",
  completed: "#3fb950",
  failed: "#f85149",
  stale: "#6e7681",
  unknown: "#8b949e",
};

const SERIES_DEFS = [
  { key: "cpu", label: "CPU", unit: "%", field: "cpuPercent", color: "#22d3ee" },
  { key: "rss", label: "RSS", unit: "B", field: "rssBytes", color: "#3fb950" },
  { key: "heap", label: "Heap", unit: "B", field: "heapUsedBytes", color: "#d29922" },
  { key: "net", label: "Network", unit: "B/s", field: "netRate", color: "#f0883e" },
];

const DEFAULT_MARGIN = { left: 230, right: 40, top: 26, bottom: 26 };
export const RESOURCE_PADDING = { left: 52, right: 16, top: 12, bottom: 22 };

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function statusColor(status, stale) {
  if (stale) return STATUS_COLORS.stale;
  return STATUS_COLORS[status] ?? STATUS_COLORS.unknown;
}

function makeXScale(window, margin = DEFAULT_MARGIN, width = 960) {
  const inner = Math.max(1, width - margin.left - margin.right);
  return (ts) => margin.left + ((ts - window.from) / Math.max(1, window.to - window.from)) * inner;
}

function effectiveEndOf(iv, renderedAt, stale) {
  if (isFiniteNumber(iv.endAt)) return iv.endAt;
  if (stale) {
    const observed = iv.freshness?.sourceObservedAt;
    return isFiniteNumber(observed) ? observed : renderedAt;
  }
  return renderedAt;
}

/**
 * @param {ReturnType<import("./ui-state.js").createUiState>} state
 * @param {{renderedAt?: number, width?: number}} [options]
 */
export function buildGanttModel(state, { renderedAt = Date.now(), width = 960 } = {}) {
  const window = state.getWindow();
  const staleIds = new Set(state.getStaleIntervals(renderedAt).map((iv) => iv.id));
  const x = makeXScale(window, DEFAULT_MARGIN, width);

  const lanes = state.getGanttLanes().map((lane) => {
    const iv = lane.interval;
    const stale = staleIds.has(iv.id);
    const effectiveEnd = effectiveEndOf(iv, renderedAt, stale);
    const start = clamp(iv.startAt, window.from, window.to);
    const end = clamp(effectiveEnd, window.from, window.to);
    const x0 = Math.min(x(start), x(end));
    const x1 = Math.max(x(start), x(end));
    return {
      ...lane,
      effectiveStart: start,
      effectiveEnd: end,
      stale,
      color: statusColor(iv.status, stale),
      x: x0,
      width: Math.max(2, x1 - x0),
    };
  });

  return {
    window,
    timeDomain: [window.from, window.to],
    lanes,
    xScale: x,
    width,
  };
}

/**
 * @param {ReturnType<import("./ui-state.js").createUiState>} state
 * @param {{renderedAt?: number, width?: number, laneHeight?: number}} [options]
 */
export function renderGanttSvg(
  state,
  { renderedAt = Date.now(), width = 960, laneHeight = 24 } = {},
) {
  const model = buildGanttModel(state, { renderedAt, width });
  const margin = DEFAULT_MARGIN;
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const height = margin.top + margin.bottom + Math.max(1, model.lanes.length) * laneHeight;
  const nowX = clamp(model.xScale(renderedAt), margin.left, width - margin.right);

  const parts = [];
  parts.push(
    `<svg class="gantt" viewBox="0 0 ${width} ${height}" role="img" aria-label="执行甘特图" xmlns="http://www.w3.org/2000/svg">`,
  );
  parts.push(
    `<rect x="0" y="0" width="${width}" height="${height}" fill="none"/>`,
  );

  model.lanes.forEach((lane, index) => {
    const y = margin.top + index * laneHeight;
    const label = lane.label.length > 28 ? `${lane.label.slice(0, 27)}…` : lane.label;
    const labelX = 8 + lane.depth * 14;
    const barY = y + 5;
    const barH = Math.max(4, laneHeight - 10);
    const markerX = lane.x + 8;
    const markerY = y + laneHeight / 2;

    parts.push(
      `<g class="lane" data-lane-id="${xmlEscape(lane.id)}" data-kind="${xmlEscape(lane.kind)}" data-depth="${lane.depth}">`,
      `<rect class="lane-bg" x="0" y="${y}" width="${width}" height="${laneHeight}" fill="#161b22" opacity="0.35"/>`,
      `<text class="lane-label" x="${labelX}" y="${y + laneHeight / 2 + 4}" font-size="11" fill="#c9d1d9">${xmlEscape(label)}</text>`,
      `<g class="bar${lane.stale ? " stale" : ""}" data-interval-id="${xmlEscape(lane.id)}" data-status="${xmlEscape(lane.status ?? "unknown")}"${typeof lane.workMode === "string" ? ` data-work-mode="${xmlEscape(lane.workMode)}"` : ""}>`,
      `<rect class="bar-body" x="${lane.x.toFixed(1)}" y="${barY}" width="${Math.max(2, lane.width).toFixed(1)}" height="${barH}" rx="3" fill="${lane.color}"/>`,
      lane.stale
        ? `<rect class="bar-stale-overlay" x="${lane.x.toFixed(1)}" y="${barY}" width="${Math.max(2, lane.width).toFixed(1)}" height="${barH}" rx="3" fill="${STALE_SHADE}"/>`
        : "",
      typeof lane.workMode === "string"
        ? `<path class="work-mode-marker" data-work-mode="${xmlEscape(lane.workMode)}" d="M ${markerX.toFixed(1)} ${(markerY - 4).toFixed(1)} L ${(markerX + 4).toFixed(1)} ${markerY.toFixed(1)} L ${markerX.toFixed(1)} ${(markerY + 4).toFixed(1)} L ${(markerX - 4).toFixed(1)} ${markerY.toFixed(1)} Z" fill="none" stroke="#0f1419" stroke-width="1.5"/>`
        : "",
      `</g>`,
      `</g>`,
    );
  });

  parts.push(
    `<line class="now-line" x1="${nowX.toFixed(1)}" y1="${margin.top}" x2="${nowX.toFixed(1)}" y2="${height - margin.bottom}" stroke="#f85149" stroke-dasharray="3 3" opacity="0.6"/>`,
    `</svg>`,
  );
  return parts.join("");
}

function sampleSeriesPoints(samples, field) {
  return samples.map((s) => ({
    ts: s.ts,
    value: isFiniteNumber(s[field]) ? s[field] : null,
    sample: s,
  }));
}

function computeNetRatePoints(samples) {
  const points = [];
  let prev = null;
  for (const s of samples) {
    let value = null;
    if (prev) {
      const dt = s.ts - prev.ts;
      const prevTotal = (isFiniteNumber(prev.netRxBytes) ? prev.netRxBytes : 0)
        + (isFiniteNumber(prev.netTxBytes) ? prev.netTxBytes : 0);
      const total = (isFiniteNumber(s.netRxBytes) ? s.netRxBytes : 0)
        + (isFiniteNumber(s.netTxBytes) ? s.netTxBytes : 0);
      const prevRxFinite = isFiniteNumber(prev.netRxBytes);
      const prevTxFinite = isFiniteNumber(prev.netTxBytes);
      const rxFinite = isFiniteNumber(s.netRxBytes);
      const txFinite = isFiniteNumber(s.netTxBytes);
      if (dt > 0 && prevRxFinite && prevTxFinite && rxFinite && txFinite) {
        value = ((total - prevTotal) / dt) * 1000;
      }
    }
    points.push({ ts: s.ts, value, sample: s });
    prev = s;
  }
  return points;
}

function splitSegments(points) {
  const segments = [];
  const gaps = [];
  let current = [];
  let gapStart = null;
  let gapEnd = null;

  for (const point of points) {
    if (point.value === null) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      if (gapStart === null) gapStart = point.ts;
      gapEnd = point.ts;
    } else {
      if (gapStart !== null) {
        gaps.push({ from: gapStart, to: gapEnd });
        gapStart = null;
        gapEnd = null;
      }
      current.push(point);
    }
  }
  if (current.length > 0) segments.push(current);
  if (gapStart !== null) gaps.push({ from: gapStart, to: gapEnd });
  return { segments, gaps };
}

function isSampleStale(sample, renderedAt) {
  const f = sample.freshness;
  if (!isRecord(f)) return false;
  const observedAt = isFiniteNumber(f.sourceObservedAt) ? f.sourceObservedAt : f.collectedAt;
  const staleAfterMs = isFiniteNumber(f.staleAfterMs) ? f.staleAfterMs : 6000;
  return isFiniteNumber(observedAt) && renderedAt - observedAt > staleAfterMs;
}

function buildStaleRanges(samples, renderedAt) {
  const ranges = [];
  let start = null;
  let end = null;
  for (const sample of samples) {
    if (isSampleStale(sample, renderedAt)) {
      if (start === null) start = sample.ts;
      end = sample.ts;
    } else if (start !== null) {
      ranges.push({ from: start, to: end });
      start = null;
      end = null;
    }
  }
  if (start !== null) ranges.push({ from: start, to: end });
  return ranges;
}

/**
 * @param {ReturnType<import("./ui-state.js").createUiState>} state
 * @param {{renderedAt?: number, width?: number}} [options]
 */
export function buildResourceModel(state, { renderedAt = Date.now(), width = 960 } = {}) {
  const window = state.getWindow();
  const samples = state.getVisibleSamples().sort((a, b) => a.ts - b.ts);
  const margin = RESOURCE_PADDING;
  const inner = Math.max(1, width - margin.left - margin.right);
  const xScale = (ts) => margin.left + ((ts - window.from) / Math.max(1, window.to - window.from)) * inner;

  const series = SERIES_DEFS.map((def) => {
    const points = def.key === "net"
      ? computeNetRatePoints(samples)
      : sampleSeriesPoints(samples, def.field);
    const { segments, gaps } = splitSegments(points);
    return {
      ...def,
      points,
      segments,
      gaps,
      xScale,
    };
  });

  return {
    window,
    timeDomain: [window.from, window.to],
    xScale,
    series,
    staleRanges: buildStaleRanges(samples, renderedAt),
    renderedAt,
  };
}

function yBoundsForSeries(series) {
  let min = Infinity;
  let max = -Infinity;
  for (const seg of series.segments) {
    for (const point of seg) {
      if (point.value === null) continue;
      if (point.value < min) min = point.value;
      if (point.value > max) max = point.value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) {
    const pad = Math.max(1, Math.abs(min) * 0.1);
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

/**
 * 在真实 Canvas 2D context 或测试用记录 context 上绘制资源折线。
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReturnType<typeof buildResourceModel>} model
 * @param {{width?: number, height?: number}} [options]
 */
export function drawResourceChart(ctx, model, { width = 960, height = 220 } = {}) {
  const margin = RESOURCE_PADDING;
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);

  // 1) stale 段着色遮罩：先画在底层。
  for (const range of model.staleRanges) {
    const x0 = clamp(model.xScale(range.from), margin.left, width - margin.right);
    const x1 = clamp(model.xScale(range.to), margin.left, width - margin.right);
    ctx.fillStyle = STALE_SHADE;
    ctx.fillRect(x0, margin.top, Math.max(1, x1 - x0), plotHeight);
  }

  // 2) 每条序列：null 缺口通过 moveTo 重新起笔，绝不跨缺口连线。
  for (const series of model.series) {
    const bounds = yBoundsForSeries(series);
    const y = (value) => margin.top
      + ((bounds.max - value) / Math.max(1, bounds.max - bounds.min)) * plotHeight;

    ctx.strokeStyle = series.color;
    ctx.beginPath();
    for (const segment of series.segments) {
      const first = segment[0];
      ctx.moveTo(model.xScale(first.ts), y(first.value));
      for (let i = 1; i < segment.length; i += 1) {
        const point = segment[i];
        ctx.lineTo(model.xScale(point.ts), y(point.value));
      }
    }
    ctx.stroke();
  }
}

function aggregateUsage(samples, from, to) {
  const bucket = samples.filter((s) => s.ts >= from && s.ts <= to);
  const usage = {
    cpuPercent: { current: null, peak: null },
    rssBytes: { current: null, peak: null },
    heapUsedBytes: { current: null, peak: null },
    netBytesPerSec: { current: null, peak: null },
  };
  if (bucket.length === 0) return usage;

  const latest = bucket[bucket.length - 1];
  for (const field of ["cpuPercent", "rssBytes", "heapUsedBytes"]) {
    const current = isFiniteNumber(latest[field]) ? latest[field] : null;
    let peak = null;
    for (const sample of bucket) {
      if (isFiniteNumber(sample[field])) {
        peak = peak === null ? sample[field] : Math.max(peak, sample[field]);
      }
    }
    usage[field] = { current, peak };
  }

  const netPoints = computeNetRatePoints(bucket);
  let current = null;
  let peak = null;
  for (const point of netPoints) {
    if (point.value !== null) {
      current = point.value;
      peak = peak === null ? point.value : Math.max(peak, point.value);
    }
  }
  usage.netBytesPerSec = { current, peak };
  return usage;
}

/**
 * 选中区间的详情模型：身份、重试、错误与关联 Batch 资源窗口摘要。
 * @param {ReturnType<import("./ui-state.js").createUiState>} state
 * @param {{renderedAt?: number}} [options]
 */
export function buildDetailModel(state, { renderedAt = Date.now() } = {}) {
  const iv = state.getSelectedInterval();
  if (!iv) return null;

  const staleIds = new Set(state.getStaleIntervals(renderedAt).map((row) => row.id));
  const stale = staleIds.has(iv.id);
  const effectiveEnd = effectiveEndOf(iv, renderedAt, stale);
  const from = Math.max(iv.startAt, state.getWindow().from);
  const to = Math.min(effectiveEnd, state.getWindow().to);

  const detail = isRecord(iv.detail) ? iv.detail : {};
  const allSamples = state.getSamples();
  const batchSamples = typeof iv.batchId === "string"
    ? allSamples.filter((s) => s.targetId === iv.batchId)
    : allSamples;

  return {
    interval: iv,
    stale,
    workerId: iv.workerId ?? null,
    roleId: iv.roleId ?? null,
    batchId: iv.batchId ?? null,
    traceId: iv.traceId ?? null,
    attempt: iv.attempt ?? null,
    retry: detail.retry ?? (isFiniteNumber(iv.attempt) && iv.attempt > 1 ? iv.attempt - 1 : 0),
    error: detail.error ?? (iv.status === "failed" ? iv.label : null),
    usage: aggregateUsage(batchSamples, from, to),
    window: { from, to },
  };
}

function fmtBytes(n) {
  if (!isFiniteNumber(n)) return "unknown";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}B`;
}

function fmtPct(n) {
  return isFiniteNumber(n) ? `${n.toFixed(1)}%` : "unknown";
}

/**
 * 文本摘要：窗口、区间数、资源当前值/峰值，供 aria-live 与无指针访问。
 * @param {ReturnType<import("./ui-state.js").createUiState>} state
 * @param {{renderedAt?: number}} [options]
 */
export function renderTextSummary(state, { renderedAt = Date.now() } = {}) {
  const window = state.getWindow();
  const preset = state.getPreset();
  const windowLabel = preset === "custom"
    ? `${new Date(window.from).toISOString()} → ${new Date(window.to).toISOString()}`
    : preset;
  const intervals = state.getVisibleIntervals();
  const samples = state.getVisibleSamples();
  const latest = samples[samples.length - 1];

  const currentCpu = latest?.cpuPercent;
  const currentRss = latest?.rssBytes;
  let peakCpu = null;
  let peakRss = null;
  for (const sample of samples) {
    if (isFiniteNumber(sample.cpuPercent)) peakCpu = peakCpu === null ? sample.cpuPercent : Math.max(peakCpu, sample.cpuPercent);
    if (isFiniteNumber(sample.rssBytes)) peakRss = peakRss === null ? sample.rssBytes : Math.max(peakRss, sample.rssBytes);
  }

  const sources = state.getSourceStates(renderedAt).map((s) => `${s.source}:${s.state}`).join(" ");
  return [
    `窗口 ${windowLabel}`,
    `${new Date(window.from).toLocaleTimeString()} → ${new Date(window.to).toLocaleTimeString()}`,
    `可见区间 ${intervals.length} 条`,
    `资源样本 ${samples.length} 条`,
    `CPU 当前 ${fmtPct(currentCpu)} 峰值 ${fmtPct(peakCpu)}`,
    `RSS 当前 ${fmtBytes(currentRss)} 峰值 ${fmtBytes(peakRss)}`,
    `来源 ${sources}`,
  ].join("；");
}
