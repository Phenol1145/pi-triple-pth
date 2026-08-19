/**
 * contracts/runtime-observation.ts — N30 运行观测台只读 DTO 与 Freshness 契约。
 *
 * 本文件只包含纯类型、结构校验和纯函数；不 import fastify / pg / redis /
 * @away_from/pth-sandbox 运行时，不写任何领域状态。
 *
 * 时间一律为 UTC epoch milliseconds；缺失资源指标保留 null，绝不合成 0。
 * Freshness 四态为 fresh / lagging / stale / disconnected，由显式注入时钟计算，
 * 任何调用方不能依赖进程本地时间获得确定性结果。
 *
 * M0（src/pth/contracts/work-mode.ts 的 canonical WorkMode）在另一条 lane 并行开发，
 * 本 lane 尚不可见，因此这里先本地定义 RUNTIME_WORK_MODES / RuntimeWorkMode。
 * 合并 M0 后改为 re-export canonical WorkMode。
 */

// ─── WorkMode（M0 合并后改为 re-export canonical WorkMode） ───────────────

export const RUNTIME_WORK_MODES = ["intake", "optimize", "run"] as const;
export type RuntimeWorkMode = (typeof RUNTIME_WORK_MODES)[number];

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

// ─── 校验结果与基础谓词 ──────────────────────────────────────────────────────

export type RuntimeObservationValidation = { ok: true } | { ok: false; error: string };

const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isNonNegativeFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isPositiveFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function fail(message: string): RuntimeObservationValidation {
  return { ok: false, error: message };
}

function prefixError(prefix: string, result: RuntimeObservationValidation): RuntimeObservationValidation {
  if (result.ok) return result;
  return { ok: false, error: `${prefix}: ${result.error}` };
}

export function isFreshnessState(v: unknown): v is FreshnessState {
  return typeof v === "string" && (FRESHNESS_STATES as readonly string[]).includes(v);
}

export function isRuntimeIntervalKind(v: unknown): v is RuntimeIntervalKind {
  return typeof v === "string" && (RUNTIME_INTERVAL_KINDS as readonly string[]).includes(v);
}

export function isRuntimeIntervalStatus(v: unknown): v is RuntimeIntervalStatus {
  return typeof v === "string" && (RUNTIME_INTERVAL_STATUSES as readonly string[]).includes(v);
}

export function isRuntimeWorkMode(v: unknown): v is RuntimeWorkMode {
  return typeof v === "string" && (RUNTIME_WORK_MODES as readonly string[]).includes(v);
}

export function isRuntimeWorkModeFilter(v: unknown): v is RuntimeWorkModeFilter {
  return typeof v === "string" && (RUNTIME_WORK_MODE_FILTERS as readonly string[]).includes(v);
}

export function isResourceTargetKind(v: unknown): v is ResourceTargetKind {
  return typeof v === "string" && (RESOURCE_TARGET_KINDS as readonly string[]).includes(v);
}

export function isResourceSampleSource(v: unknown): v is ResourceSampleSource {
  return typeof v === "string" && (RESOURCE_SAMPLE_SOURCES as readonly string[]).includes(v);
}

export function isResourceHealthState(v: unknown): v is ResourceHealthState {
  return typeof v === "string" && (RESOURCE_HEALTH_STATES as readonly string[]).includes(v);
}

export function isRuntimeSourceKind(v: unknown): v is RuntimeSourceKind {
  return typeof v === "string" && (RUNTIME_SOURCE_KINDS as readonly string[]).includes(v);
}

export function isRuntimeWarningSource(v: unknown): v is RuntimeWarningSource {
  return typeof v === "string" && (RUNTIME_WARNING_SOURCES as readonly string[]).includes(v);
}

export function isRuntimeDeltaType(v: unknown): v is RuntimeDeltaType {
  return typeof v === "string" && (RUNTIME_DELTA_TYPES as readonly string[]).includes(v);
}

export function isRuntimeHeartbeatSource(v: unknown): v is RuntimeHeartbeatSource {
  return typeof v === "string" && (RUNTIME_HEARTBEAT_SOURCES as readonly string[]).includes(v);
}

// ─── 稳定 ID helper ────────────────────────────────────────────────────────

export interface ParsedRuntimeIntervalId {
  kind: RuntimeIntervalKind;
  /** service 等中立区间无 tenant 段；tenant-owned 区间必有。 */
  tenantId?: string;
  localId: string;
}

export function buildRuntimeIntervalId(kind: RuntimeIntervalKind, localId: string, tenantId?: string): string {
  if (!isRuntimeIntervalKind(kind)) {
    throw new TypeError(`buildRuntimeIntervalId: unknown kind ${JSON.stringify(kind)}`);
  }
  if (!NON_EMPTY_STRING(localId)) {
    throw new TypeError(`buildRuntimeIntervalId: localId must be a non-empty string`);
  }
  if (kind === "service") {
    return `service:${localId}`;
  }
  if (!NON_EMPTY_STRING(tenantId)) {
    throw new TypeError(`buildRuntimeIntervalId: tenantId is required for kind ${kind}`);
  }
  return `${kind}:${tenantId}:${localId}`;
}

export function parseRuntimeIntervalId(id: unknown): ParsedRuntimeIntervalId | null {
  if (typeof id !== "string" || id.trim() === "") return null;
  const parts = id.split(":");
  if (parts.length < 2) return null;

  const kind = parts[0];
  if (!isRuntimeIntervalKind(kind)) return null;

  if (kind === "service") {
    if (parts.slice(1).some((part) => part === "")) return null;
    return { kind, localId: parts.slice(1).join(":") };
  }

  if (parts.length < 3) return null;
  const tenantId = parts[1];
  if (tenantId === "") return null;
  if (parts.slice(2).some((part) => part === "")) return null;
  return { kind, tenantId, localId: parts.slice(2).join(":") };
}

// ─── Freshness 计算 ────────────────────────────────────────────────────────

export const DEFAULT_DISCONNECTED_AFTER_MS = 30_000;

export interface FreshnessThresholds {
  laggingAfterMs: number;
  staleAfterMs: number;
  disconnectedAfterMs: number;
}

export function defaultFreshnessThresholds(
  stamp: Pick<FreshnessStamp, "expectedIntervalMs" | "staleAfterMs">,
): FreshnessThresholds {
  const laggingAfterMs = isPositiveFiniteNumber(stamp.expectedIntervalMs) ? stamp.expectedIntervalMs : 0;
  const staleAfterMs = Math.max(
    isPositiveFiniteNumber(stamp.staleAfterMs) ? stamp.staleAfterMs : 0,
    laggingAfterMs,
  );
  const disconnectedAfterMs = Math.max(staleAfterMs, DEFAULT_DISCONNECTED_AFTER_MS);
  return { laggingAfterMs, staleAfterMs, disconnectedAfterMs };
}

export function computeFreshnessState(
  stamp: Pick<FreshnessStamp, "sourceObservedAt" | "expectedIntervalMs" | "staleAfterMs">,
  nowMs: number,
  thresholds: FreshnessThresholds = defaultFreshnessThresholds(stamp),
): FreshnessState {
  const ageMs = nowMs - stamp.sourceObservedAt;
  if (ageMs <= thresholds.laggingAfterMs) return "fresh";
  if (ageMs <= thresholds.staleAfterMs) return "lagging";
  if (ageMs <= thresholds.disconnectedAfterMs) return "stale";
  return "disconnected";
}

// ─── WorkMode 过滤器 ────────────────────────────────────────────────────────

export function matchesRuntimeWorkModeFilter(
  workMode: RuntimeWorkMode | undefined,
  filter: RuntimeWorkModeFilter,
): boolean {
  if (!isRuntimeWorkModeFilter(filter)) return false;
  if (filter === "all") return true;
  return workMode === filter;
}

// ─── 结构校验 ──────────────────────────────────────────────────────────────

export function validateFreshnessStamp(v: unknown): RuntimeObservationValidation {
  if (!isRecord(v)) return fail("freshness stamp: object required");
  const s = v;
  if (!isNonNegativeFiniteNumber(s.sourceObservedAt)) {
    return fail(`freshness stamp: sourceObservedAt must be a non-negative finite number, got ${JSON.stringify(s.sourceObservedAt)}`);
  }
  if (!isNonNegativeFiniteNumber(s.collectedAt)) {
    return fail(`freshness stamp: collectedAt must be a non-negative finite number, got ${JSON.stringify(s.collectedAt)}`);
  }
  if (!isPositiveFiniteNumber(s.expectedIntervalMs)) {
    return fail(`freshness stamp: expectedIntervalMs must be a positive finite number, got ${JSON.stringify(s.expectedIntervalMs)}`);
  }
  if (!isPositiveFiniteNumber(s.staleAfterMs)) {
    return fail(`freshness stamp: staleAfterMs must be a positive finite number, got ${JSON.stringify(s.staleAfterMs)}`);
  }
  return { ok: true };
}

function validateDetail(detail: unknown): RuntimeObservationValidation {
  if (!isRecord(detail)) return fail("detail must be an object");
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return fail(`detail.${key} must be finite`);
    } else if (typeof value !== "string" && typeof value !== "boolean" && value !== null) {
      return fail(`detail.${key} must be string | number | boolean | null`);
    }
  }
  return { ok: true };
}

function validateOptionalNonEmptyString(
  container: Record<string, unknown>,
  key: string,
  label: string,
): RuntimeObservationValidation | null {
  const value = container[key];
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    return fail(`${label} must be a non-empty string`);
  }
  return null;
}

export function validateRuntimeInterval(v: unknown): RuntimeObservationValidation {
  if (!isRecord(v)) return fail("runtime interval: object required");
  const r = v;

  const id = r.id;
  if (!NON_EMPTY_STRING(id)) return fail("runtime interval: id must be a non-empty string");
  const parsedId = parseRuntimeIntervalId(id);
  if (!parsedId) return fail(`runtime interval: invalid stable id ${JSON.stringify(id)}`);

  if (!isRuntimeIntervalKind(r.kind)) {
    return fail(`runtime interval: unknown kind ${JSON.stringify(r.kind)}`);
  }
  if (parsedId.kind !== r.kind) {
    return fail(`runtime interval: id kind ${parsedId.kind} does not match kind ${String(r.kind)}`);
  }

  if (r.workMode !== undefined && !isRuntimeWorkMode(r.workMode)) {
    return fail(`runtime interval: unknown workMode ${JSON.stringify(r.workMode)}`);
  }

  if (typeof r.label !== "string") {
    return fail("runtime interval: label must be a string");
  }

  if (!isRuntimeIntervalStatus(r.status)) {
    return fail(`runtime interval: unknown status ${JSON.stringify(r.status)}`);
  }

  if (!isNonNegativeFiniteNumber(r.startAt)) {
    return fail(`runtime interval: startAt must be a non-negative finite number, got ${JSON.stringify(r.startAt)}`);
  }
  if (r.endAt !== null && !isNonNegativeFiniteNumber(r.endAt)) {
    return fail(`runtime interval: endAt must be null or a non-negative finite number, got ${JSON.stringify(r.endAt)}`);
  }
  if (typeof r.endAt === "number" && r.endAt < (r.startAt as number)) {
    return fail(`runtime interval: endAt ${r.endAt} precedes startAt ${String(r.startAt)}`);
  }

  if (!NON_EMPTY_STRING(r.sourceVersion)) {
    return fail("runtime interval: sourceVersion must be a non-empty string");
  }

  const freshness = validateFreshnessStamp(r.freshness);
  if (!freshness.ok) return prefixError("runtime interval freshness", freshness);

  const idTenant = parsedId.tenantId;
  const intervalTenant = typeof r.tenantId === "string" && r.tenantId.trim() !== "" ? r.tenantId : idTenant;
  if (r.tenantId !== undefined && (typeof r.tenantId !== "string" || r.tenantId.trim() === "")) {
    return fail("runtime interval: tenantId must be a non-empty string when present");
  }
  if (r.tenantId !== undefined && idTenant !== undefined && r.tenantId !== idTenant) {
    return fail(`runtime interval: id tenant ${idTenant} does not match tenantId ${String(r.tenantId)}`);
  }

  if (r.parentId !== undefined) {
    if (!NON_EMPTY_STRING(r.parentId)) return fail("runtime interval: parentId must be a non-empty string when present");
    const parsedParent = parseRuntimeIntervalId(r.parentId);
    if (!parsedParent) return fail(`runtime interval: invalid parent stable id ${JSON.stringify(r.parentId)}`);
    if (parsedParent.tenantId !== undefined && intervalTenant !== undefined && parsedParent.tenantId !== intervalTenant) {
      return fail(`runtime interval: cross-tenant parent ${parsedParent.tenantId} for tenant ${String(intervalTenant)}`);
    }
  }

  for (const [key, label] of [
    ["space", "space"],
    ["jobId", "jobId"],
    ["taskId", "taskId"],
    ["runId", "runId"],
    ["stage", "stage"],
    ["workerId", "workerId"],
    ["roleId", "roleId"],
    ["batchId", "batchId"],
    ["traceId", "traceId"],
  ] as const) {
    const optional = validateOptionalNonEmptyString(r, key, `runtime interval ${label}`);
    if (optional) return optional;
  }

  if (r.attempt !== undefined && !isNonNegativeInteger(r.attempt)) {
    return fail(`runtime interval: attempt must be a non-negative integer, got ${JSON.stringify(r.attempt)}`);
  }

  if (r.detail !== undefined) {
    const detail = validateDetail(r.detail);
    if (!detail.ok) return prefixError("runtime interval detail", detail);
  }

  return { ok: true };
}

function validateNullableNonNegativeMetric(value: unknown): boolean {
  return value === null || value === undefined || isNonNegativeFiniteNumber(value);
}

export function validateResourceSample(v: unknown): RuntimeObservationValidation {
  if (!isRecord(v)) return fail("resource sample: object required");
  const r = v;

  if (!isNonNegativeFiniteNumber(r.ts)) {
    return fail(`resource sample: ts must be a non-negative finite number, got ${JSON.stringify(r.ts)}`);
  }
  if (!isResourceTargetKind(r.targetKind)) {
    return fail(`resource sample: unknown targetKind ${JSON.stringify(r.targetKind)}`);
  }
  if (!NON_EMPTY_STRING(r.targetId)) {
    return fail("resource sample: targetId must be a non-empty string");
  }
  if (!isResourceSampleSource(r.source)) {
    return fail(`resource sample: unknown source ${JSON.stringify(r.source)}`);
  }

  for (const key of [
    "cpuPercent",
    "rssBytes",
    "heapUsedBytes",
    "memoryLimitBytes",
    "netRxBytes",
    "netTxBytes",
    "heartbeatLagMs",
  ] as const) {
    if (r[key] !== undefined && !validateNullableNonNegativeMetric(r[key])) {
      return fail(`resource sample: ${key} must be null or a non-negative finite number, got ${JSON.stringify(r[key])}`);
    }
  }

  if (r.health !== undefined && !isResourceHealthState(r.health)) {
    return fail(`resource sample: unknown health ${JSON.stringify(r.health)}`);
  }

  const freshness = validateFreshnessStamp(r.freshness);
  if (!freshness.ok) return prefixError("resource sample freshness", freshness);

  return { ok: true };
}

export function validateRuntimeWarning(v: unknown): RuntimeObservationValidation {
  if (!isRecord(v)) return fail("runtime warning: object required");
  const r = v;
  if (!NON_EMPTY_STRING(r.code)) return fail("runtime warning: code must be a non-empty string");
  if (!isRuntimeWarningSource(r.source)) return fail(`runtime warning: unknown source ${JSON.stringify(r.source)}`);
  if (typeof r.message !== "string") return fail("runtime warning: message must be a string");
  if (!isNonNegativeFiniteNumber(r.observedAt)) {
    return fail(`runtime warning: observedAt must be a non-negative finite number, got ${JSON.stringify(r.observedAt)}`);
  }
  if (r.staleSince !== undefined && !isNonNegativeFiniteNumber(r.staleSince)) {
    return fail(`runtime warning: staleSince must be a non-negative finite number, got ${JSON.stringify(r.staleSince)}`);
  }
  return { ok: true };
}

export function validateRuntimeHeartbeat(v: unknown): RuntimeObservationValidation {
  if (!isRecord(v)) return fail("runtime heartbeat: object required");
  const r = v;
  if (!isRuntimeHeartbeatSource(r.source)) return fail(`runtime heartbeat: unknown source ${JSON.stringify(r.source)}`);
  const freshness = validateFreshnessStamp(r.freshness);
  if (!freshness.ok) return prefixError("runtime heartbeat freshness", freshness);
  return { ok: true };
}

export function validateRuntimeSourceState(v: unknown): RuntimeObservationValidation {
  if (!isRecord(v)) return fail("runtime source state: object required");
  const r = v;
  if (!isRuntimeSourceKind(r.source)) return fail(`runtime source state: unknown source ${JSON.stringify(r.source)}`);
  if (!isFreshnessState(r.state)) return fail(`runtime source state: unknown state ${JSON.stringify(r.state)}`);
  if (r.lastSuccessAt !== null && !isNonNegativeFiniteNumber(r.lastSuccessAt)) {
    return fail(`runtime source state: lastSuccessAt must be null or a non-negative finite number, got ${JSON.stringify(r.lastSuccessAt)}`);
  }
  if (!isNonNegativeFiniteNumber(r.lastAttemptAt)) {
    return fail(`runtime source state: lastAttemptAt must be a non-negative finite number, got ${JSON.stringify(r.lastAttemptAt)}`);
  }
  if (!isPositiveFiniteNumber(r.expectedIntervalMs)) {
    return fail(`runtime source state: expectedIntervalMs must be a positive finite number, got ${JSON.stringify(r.expectedIntervalMs)}`);
  }
  if (!isPositiveFiniteNumber(r.staleAfterMs)) {
    return fail(`runtime source state: staleAfterMs must be a positive finite number, got ${JSON.stringify(r.staleAfterMs)}`);
  }
  if (!isNonNegativeInteger(r.consecutiveFailures)) {
    return fail(`runtime source state: consecutiveFailures must be a non-negative integer, got ${JSON.stringify(r.consecutiveFailures)}`);
  }
  return { ok: true };
}

export function validateRuntimeSummary(v: unknown): RuntimeObservationValidation {
  if (!isRecord(v)) return fail("runtime summary: object required");
  const r = v;
  for (const key of [
    "activeTasks",
    "queuedTasks",
    "workers",
    "idleWorkers",
    "activeIntakeRuns",
    "activeOptimizeWorks",
    "activeRunWorks",
    "alerts",
  ] as const) {
    if (!isNonNegativeInteger(r[key])) {
      return fail(`runtime summary: ${key} must be a non-negative integer, got ${JSON.stringify(r[key])}`);
    }
  }
  return { ok: true };
}

export function validateRuntimeSnapshot(v: unknown): RuntimeObservationValidation {
  if (!isRecord(v)) return fail("runtime snapshot: object required");
  const r = v;

  if (!NON_EMPTY_STRING(r.snapshotId)) return fail("runtime snapshot: snapshotId must be a non-empty string");
  if (!isNonNegativeFiniteNumber(r.collectedAt)) {
    return fail(`runtime snapshot: collectedAt must be a non-negative finite number, got ${JSON.stringify(r.collectedAt)}`);
  }

  const window = r.window;
  if (!isRecord(window)) return fail("runtime snapshot: window must be an object");
  if (!isNonNegativeFiniteNumber(window.from) || !isNonNegativeFiniteNumber(window.to)) {
    return fail("runtime snapshot: window.from/window.to must be non-negative finite numbers");
  }
  if (window.to < window.from) {
    return fail(`runtime snapshot: window.to ${String(window.to)} precedes window.from ${String(window.from)}`);
  }

  const scope = r.scope;
  if (!isRecord(scope)) return fail("runtime snapshot: scope must be an object");
  if (scope.mode !== "local-admin") return fail("runtime snapshot: scope.mode must be local-admin");
  if (!NON_EMPTY_STRING(scope.tenantId)) return fail("runtime snapshot: scope.tenantId must be a non-empty string");
  if (scope.space !== undefined && (typeof scope.space !== "string" || scope.space.trim() === "")) {
    return fail("runtime snapshot: scope.space must be a non-empty string when present");
  }

  const summary = validateRuntimeSummary(r.summary);
  if (!summary.ok) return prefixError("runtime snapshot summary", summary);

  if (!Array.isArray(r.intervals)) return fail("runtime snapshot: intervals must be an array");
  for (const [index, interval] of (r.intervals as unknown[]).entries()) {
    const result = validateRuntimeInterval(interval);
    if (!result.ok) return prefixError(`runtime snapshot: intervals[${index}]`, result);
  }

  if (!Array.isArray(r.resources)) return fail("runtime snapshot: resources must be an array");
  for (const [index, sample] of (r.resources as unknown[]).entries()) {
    const result = validateResourceSample(sample);
    if (!result.ok) return prefixError(`runtime snapshot: resources[${index}]`, result);
  }

  if (!Array.isArray(r.sources)) return fail("runtime snapshot: sources must be an array");
  for (const [index, source] of (r.sources as unknown[]).entries()) {
    const result = validateRuntimeSourceState(source);
    if (!result.ok) return prefixError(`runtime snapshot: sources[${index}]`, result);
  }

  if (!Array.isArray(r.warnings)) return fail("runtime snapshot: warnings must be an array");
  for (const [index, warning] of (r.warnings as unknown[]).entries()) {
    const result = validateRuntimeWarning(warning);
    if (!result.ok) return prefixError(`runtime snapshot: warnings[${index}]`, result);
  }

  return { ok: true };
}

export function validateRuntimeDelta(v: unknown): RuntimeObservationValidation {
  if (!isRecord(v)) return fail("runtime delta: object required");
  const r = v;

  if (!NON_EMPTY_STRING(r.streamEpoch)) return fail("runtime delta: streamEpoch must be a non-empty string");
  if (!isNonNegativeInteger(r.seq)) {
    return fail(`runtime delta: seq must be a non-negative integer, got ${JSON.stringify(r.seq)}`);
  }
  if (!isNonNegativeFiniteNumber(r.observedAt)) {
    return fail(`runtime delta: observedAt must be a non-negative finite number, got ${JSON.stringify(r.observedAt)}`);
  }
  if (!isRuntimeDeltaType(r.type)) {
    return fail(`runtime delta: unknown type ${JSON.stringify(r.type)}`);
  }

  switch (r.type) {
    case "snapshot":
      return prefixError("runtime delta payload snapshot", validateRuntimeSnapshot(r.payload));
    case "interval.upsert":
      return prefixError("runtime delta payload interval.upsert", validateRuntimeInterval(r.payload));
    case "resource.sample":
      return prefixError("runtime delta payload resource.sample", validateResourceSample(r.payload));
    case "warning.upsert":
      return prefixError("runtime delta payload warning.upsert", validateRuntimeWarning(r.payload));
    case "heartbeat":
      return prefixError("runtime delta payload heartbeat", validateRuntimeHeartbeat(r.payload));
  }
}
