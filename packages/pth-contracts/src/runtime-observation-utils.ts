/**
 * contracts/runtime-observation-utils.ts —— N30 运行观测台纯工具函数。
 *
 * 从 `runtime-observation.ts` 非破坏性拆分：谓词、稳定 ID、Freshness 计算与 WorkMode 过滤。
 */

import {
  FRESHNESS_STATES,
  RESOURCE_HEALTH_STATES,
  RESOURCE_SAMPLE_SOURCES,
  RESOURCE_TARGET_KINDS,
  RUNTIME_DELTA_TYPES,
  RUNTIME_HEARTBEAT_SOURCES,
  RUNTIME_INTERVAL_KINDS,
  RUNTIME_INTERVAL_STATUSES,
  RUNTIME_SOURCE_KINDS,
  RUNTIME_WARNING_SOURCES,
  RUNTIME_WORK_MODES,
  RUNTIME_WORK_MODE_FILTERS,
  type FreshnessStamp,
  type FreshnessState,
  type FreshnessThresholds,
  type ParsedRuntimeIntervalId,
  type ResourceHealthState,
  type ResourceSampleSource,
  type ResourceTargetKind,
  type RuntimeDeltaType,
  type RuntimeHeartbeatSource,
  type RuntimeIntervalKind,
  type RuntimeIntervalStatus,
  type RuntimeSourceKind,
  type RuntimeWarningSource,
  type RuntimeWorkMode,
  type RuntimeWorkModeFilter,
} from "./runtime-observation-types.js";

const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function isPositiveFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
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
