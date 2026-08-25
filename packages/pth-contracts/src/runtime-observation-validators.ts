/**
 * contracts/runtime-observation-validators.ts —— N30 运行观测台 DTO 结构校验。
 *
 * 从 `runtime-observation.ts` 非破坏性拆分：全部 `validate*` 纯函数集中于此。
 */

import type { RuntimeObservationValidation } from "./runtime-observation-types.js";
import {
  isFreshnessState,
  isResourceHealthState,
  isResourceSampleSource,
  isResourceTargetKind,
  isRuntimeDeltaType,
  isRuntimeHeartbeatSource,
  isRuntimeIntervalKind,
  isRuntimeIntervalStatus,
  isRuntimeSourceKind,
  isRuntimeWarningSource,
  isRuntimeWorkMode,
  parseRuntimeIntervalId,
} from "./runtime-observation-utils.js";

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
