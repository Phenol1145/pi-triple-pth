/**
 * contracts/runtime-observation-types.ts —— N30 运行观测台只读 DTO 与常量契约。
 *
 * 从 `runtime-observation.ts` 非破坏性拆分：类型/常量集中于此。
 */

import { WORK_MODES, type WorkMode } from "./work-mode.js";

// ─── WorkMode（canonical WorkMode 的观测侧别名） ──────────────────────────

export const RUNTIME_WORK_MODES = WORK_MODES;
export type RuntimeWorkMode = WorkMode;

export const RUNTIME_WORK_MODE_FILTERS = ["all", "intake", "optimize", "run"] as const;
export type RuntimeWorkModeFilter = (typeof RUNTIME_WORK_MODE_FILTERS)[number];

// ─── DTO 类型 ──────────────────────────────────────────────────────────────

export const RUNTIME_INTERVAL_KINDS = [
  "service",
  "job",
  "task",
  "optimizer-work",
  "professional-job",
  "intake-run",
  "intake-stage",
] as const;
export type RuntimeIntervalKind = (typeof RUNTIME_INTERVAL_KINDS)[number];

export const RUNTIME_INTERVAL_STATUSES = [
  "queued",
  "running",
  "waiting",
  "retrying",
  "completed",
  "failed",
  "stale",
  "unknown",
] as const;
export type RuntimeIntervalStatus = (typeof RUNTIME_INTERVAL_STATUSES)[number];

export const FRESHNESS_STATES = ["fresh", "lagging", "stale", "disconnected"] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

export interface FreshnessStamp {
  /** 来源产生或确认该事实的时间。 */
  sourceObservedAt: number;
  /** 聚合器收到并接受该事实的时间。 */
  collectedAt: number;
  expectedIntervalMs: number;
  staleAfterMs: number;
}

export interface RuntimeInterval {
  id: string;
  parentId?: string;
  kind: RuntimeIntervalKind;
  /** service 等中立基础设施区间可为空；业务 work 必须由服务端投影。 */
  workMode?: RuntimeWorkMode;
  label: string;
  status: RuntimeIntervalStatus;
  /** 来源内单调版本；优先使用 rowVersion，否则使用规范化 updatedAt。 */
  sourceVersion: string;
  startAt: number;
  /** 运行中为 null；UI 只能延伸到 sourceObservedAt。 */
  endAt: number | null;
  freshness: FreshnessStamp;
  tenantId?: string;
  space?: string;
  jobId?: string;
  taskId?: string;
  runId?: string;
  stage?: string;
  attempt?: number;
  workerId?: string;
  roleId?: string;
  batchId?: string;
  traceId?: string;
  detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export const RESOURCE_TARGET_KINDS = ["container", "batch", "process", "system"] as const;
export type ResourceTargetKind = (typeof RESOURCE_TARGET_KINDS)[number];

export const RESOURCE_SAMPLE_SOURCES = ["docker", "pth-batch", "pth-process"] as const;
export type ResourceSampleSource = (typeof RESOURCE_SAMPLE_SOURCES)[number];

export const RESOURCE_HEALTH_STATES = ["healthy", "stale", "dead", "unknown"] as const;
export type ResourceHealthState = (typeof RESOURCE_HEALTH_STATES)[number];

export interface ResourceSample {
  ts: number;
  targetKind: ResourceTargetKind;
  targetId: string;
  /** 缺失指标保留 null；调用方不得将其替换为 0。 */
  cpuPercent?: number | null;
  rssBytes?: number | null;
  heapUsedBytes?: number | null;
  memoryLimitBytes?: number | null;
  netRxBytes?: number | null;
  netTxBytes?: number | null;
  heartbeatLagMs?: number | null;
  health?: ResourceHealthState;
  source: ResourceSampleSource;
  freshness: FreshnessStamp;
}

export const RUNTIME_SOURCE_KINDS = ["docker", "pth-timeline", "pth-events"] as const;
export type RuntimeSourceKind = (typeof RUNTIME_SOURCE_KINDS)[number];

export interface RuntimeSourceState {
  source: RuntimeSourceKind;
  state: FreshnessState;
  lastSuccessAt: number | null;
  lastAttemptAt: number;
  expectedIntervalMs: number;
  staleAfterMs: number;
  consecutiveFailures: number;
}

export interface RuntimeSummary {
  activeTasks: number;
  queuedTasks: number;
  workers: number;
  idleWorkers: number;
  activeIntakeRuns: number;
  activeOptimizeWorks: number;
  activeRunWorks: number;
  alerts: number;
}

export const RUNTIME_WARNING_SOURCES = ["docker", "pth", "aggregator"] as const;
export type RuntimeWarningSource = (typeof RUNTIME_WARNING_SOURCES)[number];

export interface RuntimeWarning {
  code: string;
  source: RuntimeWarningSource;
  message: string;
  observedAt: number;
  staleSince?: number;
}

export interface RuntimeSnapshot {
  snapshotId: string;
  collectedAt: number;
  window: { from: number; to: number };
  scope: { mode: "local-admin"; tenantId: string; space?: string };
  summary: RuntimeSummary;
  intervals: readonly RuntimeInterval[];
  resources: readonly ResourceSample[];
  sources: readonly RuntimeSourceState[];
  warnings: readonly RuntimeWarning[];
}

export const RUNTIME_DELTA_TYPES = [
  "snapshot",
  "interval.upsert",
  "resource.sample",
  "warning.upsert",
  "heartbeat",
] as const;
export type RuntimeDeltaType = (typeof RUNTIME_DELTA_TYPES)[number];

export const RUNTIME_HEARTBEAT_SOURCES = ["pth-events", "aggregator"] as const;
export type RuntimeHeartbeatSource = (typeof RUNTIME_HEARTBEAT_SOURCES)[number];

export interface RuntimeHeartbeat {
  source: RuntimeHeartbeatSource;
  freshness: FreshnessStamp;
}

export interface RuntimeDelta {
  streamEpoch: string;
  seq: number;
  observedAt: number;
  type: RuntimeDeltaType;
  payload: RuntimeSnapshot | RuntimeInterval | ResourceSample | RuntimeWarning | RuntimeHeartbeat;
}

// ─── 校验结果与 ID helper 类型 ──────────────────────────────────────────────

export type RuntimeObservationValidation = { ok: true } | { ok: false; error: string };

export interface ParsedRuntimeIntervalId {
  kind: RuntimeIntervalKind;
  /** service 等中立区间无 tenant 段；tenant-owned 区间必有。 */
  tenantId?: string;
  localId: string;
}

export interface FreshnessThresholds {
  laggingAfterMs: number;
  staleAfterMs: number;
  disconnectedAfterMs: number;
}
