/**
 * alerts.js — N30 Task 6 只读告警评估器。
 *
 * 职责（plan Task 6 Step 1/3）：
 *  - 从 sources / summary / intervals / samples 派生只读告警；
 *  - 覆盖 heartbeat stale/dead、队列积压、CPU/RSS 阈值、任务超时、
 *    intake/professional 阶段停滞；
 *  - 每条告警都带 source、interval 与 evidenceWindow；
 *  - 评估器只读：不发起网络请求、不触碰 Docker Socket、绝不调用控制 API。
 *
 * 本模块无 Node/浏览器依赖，可被 server 与单测直接 import。
 */

const DEFAULT_DISCONNECTED_AFTER_MS = 30_000;

/** 默认阈值：服务器资源/任务节奏的保守门限，调用方可整体或逐项覆盖。 */
export const DEFAULT_ALERT_THRESHOLDS = Object.freeze({
  queueBacklog: 50,
  cpuPercent: 90,
  rssBytes: 1 * 1024 * 1024 * 1024,
  taskTimeoutMs: 24 * 3_600_000,
  stageStallMs: 4 * 3_600_000,
  evidenceWindowMs: 60_000,
});

const SOURCE_STATES = new Set(["fresh", "lagging", "stale", "disconnected"]);

const ACTIVE_TASK_STATUSES = new Set(["running", "waiting", "retrying"]);
const ACTIVE_STAGE_STATUSES = new Set(["running", "waiting"]);
const STAGE_KINDS = new Set(["intake-run", "intake-stage", "professional-job"]);

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function sourceNameOf(source) {
  return isRecord(source) && typeof source.source === "string" && source.source !== ""
    ? source.source
    : "unknown";
}

function intervalSourceOf(iv) {
  return isRecord(iv) && iv.kind === "service" ? "docker" : "pth-timeline";
}

/**
 * 来源状态：优先采用显式注入的 state（server 端 buildSourceStates 已算好），
 * 否则按 observedAt 注入时钟重新计算，语义与 runtime-aggregator 一致。
 */
function computeSourceState(source, now) {
  if (!isRecord(source)) return "disconnected";
  const observedAt = isFiniteNumber(source.sourceObservedAt)
    ? source.sourceObservedAt
    : isFiniteNumber(source.lastSuccessAt)
      ? source.lastSuccessAt
      : null;
  if (!isFiniteNumber(observedAt)) return "disconnected";

  const expectedIntervalMs = isFiniteNumber(source.expectedIntervalMs)
    ? source.expectedIntervalMs
    : 0;
  const staleAfterMs = Math.max(
    isFiniteNumber(source.staleAfterMs) ? source.staleAfterMs : 0,
    expectedIntervalMs,
  );
  const disconnectedAfterMs = Math.max(staleAfterMs, DEFAULT_DISCONNECTED_AFTER_MS);
  const ageMs = now - observedAt;
  if (ageMs > disconnectedAfterMs) return "disconnected";
  if (ageMs > staleAfterMs) return "stale";
  if (ageMs > expectedIntervalMs) return "lagging";
  return "fresh";
}

function resolveThresholds(thresholds) {
  return { ...DEFAULT_ALERT_THRESHOLDS, ...(isRecord(thresholds) ? thresholds : {}) };
}

function makeAlert(code, {
  severity,
  source,
  interval,
  evidenceWindow,
  value,
  threshold,
  message,
}) {
  return {
    code,
    severity,
    source,
    interval,
    evidenceWindow,
    value: isFiniteNumber(value) ? value : null,
    threshold: isFiniteNumber(threshold) ? threshold : null,
    message,
  };
}

/**
 * 只读评估：把当前观测面（sources/summary/intervals/samples）折叠成告警数组。
 * 该函数不持有任何控制 API 引用；options.controlApi 即使传入也绝不调用。
 *
 * @param {object} [input]
 * @param {number} [input.now] 评估时刻（缺省用 options.clock 或 Date.now）
 * @param {Array<Record<string, unknown>>} [input.sources]
 * @param {Record<string, unknown>} [input.summary]
 * @param {Array<Record<string, unknown>>} [input.intervals]
 * @param {Array<Record<string, unknown>>} [input.samples]
 * @param {object} [options]
 * @param {() => number} [options.clock]
 * @param {Record<string, number>} [options.thresholds]
 * @param {unknown} [options.controlApi] 仅用于测试断言"绝不调用"；实现必须忽略它。
 */
export function evaluateAlerts(input = {}, options = {}) {
  const thresholds = resolveThresholds(options?.thresholds);
  const now = isFiniteNumber(input?.now)
    ? input.now
    : typeof options?.clock === "function"
      ? options.clock()
      : Date.now();
  const sources = Array.isArray(input?.sources) ? input.sources : [];
  const summary = isRecord(input?.summary) ? input.summary : {};
  const intervals = Array.isArray(input?.intervals) ? input.intervals : [];
  const samples = Array.isArray(input?.samples) ? input.samples : [];

  const alerts = [];

  // 1) heartbeat stale/dead：来源级告警，interval 固定为 null。
  for (const source of sources) {
    if (!isRecord(source)) continue;
    const state = typeof source.state === "string" && SOURCE_STATES.has(source.state)
      ? source.state
      : computeSourceState(source, now);
    if (state !== "stale" && state !== "disconnected") continue;

    const observedAt = isFiniteNumber(source.sourceObservedAt)
      ? source.sourceObservedAt
      : isFiniteNumber(source.lastSuccessAt)
        ? source.lastSuccessAt
        : now - thresholds.evidenceWindowMs;
    const from = Math.min(observedAt, now);
    const evidenceWindow = { from, to: now };
    const code = state === "stale" ? "heartbeat.stale" : "heartbeat.dead";
    alerts.push(makeAlert(code, {
      severity: state === "stale" ? "warning" : "critical",
      source: sourceNameOf(source),
      interval: null,
      evidenceWindow,
      value: isFiniteNumber(source.sourceObservedAt) ? source.sourceObservedAt : null,
      threshold: isFiniteNumber(source.staleAfterMs) ? source.staleAfterMs : null,
      message: `source ${sourceNameOf(source)} is ${state}`,
    }));
  }

  // 2) 队列积压：来自 summary（server 端已聚合）。
  const queuedTasks = summary.queuedTasks;
  if (isFiniteNumber(queuedTasks) && queuedTasks >= thresholds.queueBacklog) {
    alerts.push(makeAlert("queue.backlog", {
      severity: "warning",
      source: "aggregator",
      interval: null,
      evidenceWindow: { from: now - thresholds.evidenceWindowMs, to: now },
      value: queuedTasks,
      threshold: thresholds.queueBacklog,
      message: `queued tasks ${queuedTasks} >= ${thresholds.queueBacklog}`,
    }));
  }

  // 3) CPU/RSS 阈值：只读样本；null 指标直接跳过（缺失绝不合成 0）。
  const cpuViolations = [];
  const rssViolations = [];
  for (const sample of samples) {
    if (!isRecord(sample) || !isFiniteNumber(sample.ts)) continue;
    if (isFiniteNumber(sample.cpuPercent) && sample.cpuPercent > thresholds.cpuPercent) {
      cpuViolations.push(sample);
    }
    if (isFiniteNumber(sample.rssBytes) && sample.rssBytes > thresholds.rssBytes) {
      rssViolations.push(sample);
    }
  }

  function latestViolation(violations) {
    return violations.reduce((latest, sample) => (sample.ts >= latest.ts ? sample : latest), violations[0]);
  }

  if (cpuViolations.length > 0) {
    const latest = latestViolation(cpuViolations);
    const value = Math.max(...cpuViolations.map((s) => s.cpuPercent));
    alerts.push(makeAlert("resource.cpu", {
      severity: "critical",
      source: sourceNameOf(latest) === "unknown" ? "docker" : sourceNameOf(latest),
      interval: null,
      evidenceWindow: { from: latest.ts - thresholds.evidenceWindowMs, to: latest.ts },
      value,
      threshold: thresholds.cpuPercent,
      message: `cpu ${value}% > ${thresholds.cpuPercent}%`,
    }));
  }
  if (rssViolations.length > 0) {
    const latest = latestViolation(rssViolations);
    const value = Math.max(...rssViolations.map((s) => s.rssBytes));
    alerts.push(makeAlert("resource.rss", {
      severity: "critical",
      source: sourceNameOf(latest) === "unknown" ? "docker" : sourceNameOf(latest),
      interval: null,
      evidenceWindow: { from: latest.ts - thresholds.evidenceWindowMs, to: latest.ts },
      value,
      threshold: thresholds.rssBytes,
      message: `rss ${value}B > ${thresholds.rssBytes}B`,
    }));
  }

  // 4) 任务超时 / 5) 摄入/专业阶段停滞：interval 级告警。
  for (const iv of intervals) {
    if (!isRecord(iv) || !isFiniteNumber(iv.startAt)) continue;
    const kind = typeof iv.kind === "string" ? iv.kind : "";
    const status = typeof iv.status === "string" ? iv.status : "";
    const evidenceWindow = { from: iv.startAt, to: now };
    const source = intervalSourceOf(iv);
    const interval = { ...iv };

    if (kind === "task" && ACTIVE_TASK_STATUSES.has(status)) {
      const runningMs = now - iv.startAt;
      if (runningMs > thresholds.taskTimeoutMs) {
        alerts.push(makeAlert("task.timeout", {
          severity: "warning",
          source,
          interval,
          evidenceWindow,
          value: runningMs,
          threshold: thresholds.taskTimeoutMs,
          message: `task ${iv.id ?? "(unknown)"} active for ${runningMs}ms`,
        }));
      }
    }

    if (STAGE_KINDS.has(kind) && ACTIVE_STAGE_STATUSES.has(status)) {
      const runningMs = now - iv.startAt;
      if (runningMs > thresholds.stageStallMs) {
        alerts.push(makeAlert("stage.stall", {
          severity: "warning",
          source,
          interval,
          evidenceWindow,
          value: runningMs,
          threshold: thresholds.stageStallMs,
          message: `${kind} ${iv.id ?? "(unknown)"} stalled for ${runningMs}ms`,
        }));
      }
    }
  }

  return alerts;
}

/**
 * 评估器工厂：固定阈值/时钟，供 server 或测试反复调用。
 * options.controlApi 仅被测试注入以证明"绝不调用"；实现不持有、不引用它。
 *
 * @param {object} [options]
 * @param {() => number} [options.clock]
 * @param {Record<string, number>} [options.thresholds]
 * @param {unknown} [options.controlApi]
 */
export function createAlertEvaluator(options = {}) {
  return {
    /**
     * @param {object} [input]
     */
    evaluate(input = {}) {
      return evaluateAlerts(input, options);
    },
  };
}
