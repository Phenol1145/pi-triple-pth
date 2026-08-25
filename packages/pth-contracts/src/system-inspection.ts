/**
 * contracts/system-inspection.ts — N33 Task 3：PTH Operator Console 只读巡检投影 DTO。
 *
 * 本文件只包含纯类型、结构校验和纯函数；不 import fastify / pg / redis /
 * @away_from/pth-sandbox 运行时实现，不写任何领域状态。
 *
 * 红线（plan Task 3 Step 1/4）：
 *  - secret 配置条目 effective/default 恒为 `***`，validator 拒绝未打码 secret；
 *  - MemoryListItem / MemoryRevisionEvent 不携带 tenantId / content / meta 原文；
 *  - WorkerInspection 排除 prompt / content / secret / environment；
 *  - source enum 只允许 default/env/runtime/file/unknown，绝不从等值推断。
 */

import { MEMORY_TYPES, type CognitiveUsage, type MemoryType } from "./cognitive-responsibility.js";
import { isWorkMode, WORK_MODES, type WorkMode } from "./work-mode.js";

// ─── 分页边界 ──────────────────────────────────────────────────────────────

export const SYSTEM_INSPECTION_DEFAULT_LIMIT = 20;
export const SYSTEM_INSPECTION_MAX_LIMIT = 100;

// ─── 配置巡检 ──────────────────────────────────────────────────────────────

export const CONFIG_SOURCES = ["default", "env", "runtime", "file", "unknown"] as const;
export type ConfigSource = (typeof CONFIG_SOURCES)[number];

export const CONFIG_VALUE_TYPES = ["string", "number", "boolean", "string[]", "json"] as const;
export type ConfigInspectionValueType = (typeof CONFIG_VALUE_TYPES)[number];

export const CONFIG_INSPECTION_MASK = "***";

export interface ConfigInspectionEntry {
  key: string;
  type: ConfigInspectionValueType;
  group: string;
  scope: string;
  description: string;
  secret: boolean;
  runtime: boolean;
  source: ConfigSource;
  /** secret=true 时恒为 `***`（默认值同理）——即便显式传入原文也必须打码。 */
  effectiveValue: string;
  defaultValue: string;
}

/** 纯函数构造 ConfigInspectionEntry：secret 条目强制打码，source 只接受枚举。 */
export function configEntry(input: {
  key: string;
  secret?: boolean;
  effective?: string;
  defaultValue?: string;
  source?: ConfigSource | string;
  type?: ConfigInspectionValueType;
  group?: string;
  scope?: string;
  description?: string;
  runtime?: boolean;
}): ConfigInspectionEntry {
  const secret = input.secret === true;
  const source = (CONFIG_SOURCES as readonly string[]).includes(input.source ?? "")
    ? (input.source as ConfigSource)
    : "unknown";
  return {
    key: input.key,
    type: input.type ?? "string",
    group: input.group ?? "infra",
    scope: input.scope ?? "both",
    description: input.description ?? "",
    secret,
    runtime: input.runtime ?? false,
    source,
    effectiveValue: secret ? CONFIG_INSPECTION_MASK : (input.effective ?? ""),
    defaultValue: secret ? CONFIG_INSPECTION_MASK : (input.defaultValue ?? ""),
  };
}

// ─── Memory 巡检 ───────────────────────────────────────────────────────────

export interface MemoryListItem {
  id: string;
  kind: string;
  status: string;
  anchors: readonly string[];
  /** canonical MemoryType（由 kind → 五类的唯一映射投影；未知 kind 不进入列表）。 */
  memoryType: MemoryType;
  version: number;
  createdAt: string;
  updatedAt: string;
  contentBytes: number;
}

export interface MemorySummary {
  byType: Record<MemoryType, { count: number; bytes: number }>;
  totals: { count: number; bytes: number };
}

export interface MemoryRevisionEvent {
  entryId: string;
  revision: number;
  status: string;
  createdAt: string;
  createdBy?: string | null;
  reason?: string | null;
}

// ─── Worker 巡检 ───────────────────────────────────────────────────────────

export const WORKER_LIFECYCLES = ["idle", "busy", "paused", "draining", "stopped", "unknown"] as const;
export type WorkerLifecycle = (typeof WORKER_LIFECYCLES)[number];

export interface WorkerWorkingSetInspection {
  entryIds: readonly string[];
  skillIndexIds: readonly string[];
  activeSkillIds: readonly string[];
  counts: {
    memoryEntries: number;
    skillIndexEntries: number;
    activeSkills: number;
    tools: number;
  };
  usage: CognitiveUsage;
  omitted: Readonly<Record<string, number>>;
}

export interface WorkerInspection {
  workerId: string;
  batchId: string;
  role: { roleId: string; revision: string };
  lifecycle: WorkerLifecycle;
  workMode: WorkMode | null;
  currentTaskId?: string | null;
  leaseId?: string | null;
  regionIds: readonly string[];
  regionWeights: Readonly<Record<string, number>>;
  workingSet: WorkerWorkingSetInspection;
  toolNames: readonly string[];
  skillIds: readonly string[];
  heartbeatLagMs: number | null;
}

// ─── Role 巡检 ─────────────────────────────────────────────────────────────

export interface RoleInspection {
  roleId: string;
  revision: string;
  parent?: string | null;
  generation?: number;
  tags: readonly string[];
  capabilities?: readonly string[];
  thinking?: "high" | "medium" | "low" | null;
  acceptanceRole?: "read-only" | "writer" | null;
  description?: string;
}

// ─── 校验结果与基础谓词 ──────────────────────────────────────────────────────

export type SystemInspectionValidation = { ok: true } | { ok: false; reason: string };

const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonNegativeInteger = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isNonNegativeFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isStringArray = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every(NON_EMPTY_STRING);

function fail(reason: string): SystemInspectionValidation {
  return { ok: false, reason };
}

function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === "string" && (MEMORY_TYPES as readonly string[]).includes(v);
}

function isConfigSource(v: unknown): v is ConfigSource {
  return typeof v === "string" && (CONFIG_SOURCES as readonly string[]).includes(v);
}

function isConfigValueType(v: unknown): v is ConfigInspectionValueType {
  return typeof v === "string" && (CONFIG_VALUE_TYPES as readonly string[]).includes(v);
}

function isWorkerLifecycle(v: unknown): v is WorkerLifecycle {
  return typeof v === "string" && (WORKER_LIFECYCLES as readonly string[]).includes(v);
}

function isNonNegativeWeights(v: unknown): v is Readonly<Record<string, number>> {
  if (!isRecord(v)) return false;
  return Object.values(v).every(isNonNegativeFiniteNumber);
}

function isWorkingSetCounts(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return isNonNegativeInteger(v.memoryEntries)
    && isNonNegativeInteger(v.skillIndexEntries)
    && isNonNegativeInteger(v.activeSkills)
    && isNonNegativeInteger(v.tools);
}

function isWorkingSetUsage(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return isNonNegativeInteger(v.memoryEntries)
    && isNonNegativeFiniteNumber(v.memoryChars)
    && isNonNegativeInteger(v.skillIndexEntries)
    && isNonNegativeInteger(v.activeSkills)
    && isNonNegativeFiniteNumber(v.skillChars)
    && isNonNegativeInteger(v.tools);
}

function validateWorkingSet(v: unknown): SystemInspectionValidation {
  if (!isRecord(v)) return fail("workingSet must be an object");
  if (!isStringArray(v.entryIds)) return fail("workingSet.entryIds must be a string array");
  if (!isStringArray(v.skillIndexIds)) return fail("workingSet.skillIndexIds must be a string array");
  if (!isStringArray(v.activeSkillIds)) return fail("workingSet.activeSkillIds must be a string array");
  if (!isWorkingSetCounts(v.counts)) return fail("workingSet.counts must contain non-negative integer counts");
  if (!isWorkingSetUsage(v.usage)) return fail("workingSet.usage must contain non-negative usage numbers");
  if (v.omitted !== undefined && !isNonNegativeWeights(v.omitted)) return fail("workingSet.omitted values must be non-negative numbers");
  return { ok: true };
}

// ─── DTO validators ─────────────────────────────────────────────────────────

export function validateConfigInspectionEntry(v: unknown): SystemInspectionValidation {
  if (!isRecord(v)) return fail("ConfigInspectionEntry must be an object");
  if (!NON_EMPTY_STRING(v.key)) return fail("ConfigInspectionEntry.key must be a non-empty string");
  if (!isConfigValueType(v.type)) return fail(`ConfigInspectionEntry.type must be one of ${CONFIG_VALUE_TYPES.join(",")}`);
  if (!NON_EMPTY_STRING(v.group)) return fail("ConfigInspectionEntry.group must be a non-empty string");
  if (!NON_EMPTY_STRING(v.scope)) return fail("ConfigInspectionEntry.scope must be a non-empty string");
  if (!isConfigSource(v.source)) return fail(`ConfigInspectionEntry.source must be one of ${CONFIG_SOURCES.join(",")}`);
  if (typeof v.secret !== "boolean") return fail("ConfigInspectionEntry.secret must be a boolean");
  if (typeof v.runtime !== "boolean") return fail("ConfigInspectionEntry.runtime must be a boolean");
  if (typeof v.effectiveValue !== "string" || typeof v.defaultValue !== "string") {
    return fail("ConfigInspectionEntry effectiveValue/defaultValue must be strings");
  }
  if (v.secret === true && (v.effectiveValue !== CONFIG_INSPECTION_MASK || v.defaultValue !== CONFIG_INSPECTION_MASK)) {
    return fail(`secret ConfigInspectionEntry effectiveValue/defaultValue must both be ${CONFIG_INSPECTION_MASK}`);
  }
  return { ok: true };
}

export function validateMemoryListItem(v: unknown): SystemInspectionValidation {
  if (!isRecord(v)) return fail("MemoryListItem must be an object");
  if (!NON_EMPTY_STRING(v.id)) return fail("MemoryListItem.id must be a non-empty string");
  if (!NON_EMPTY_STRING(v.kind)) return fail("MemoryListItem.kind must be a non-empty string");
  if (!NON_EMPTY_STRING(v.status)) return fail("MemoryListItem.status must be a non-empty string");
  if (!isStringArray(v.anchors) || v.anchors.length === 0) return fail("MemoryListItem.anchors must be a non-empty string array");
  if (!isMemoryType(v.memoryType)) return fail(`MemoryListItem.memoryType must be one of ${MEMORY_TYPES.join(",")}`);
  if (!Number.isSafeInteger(v.version) || (v.version as number) < 1) return fail("MemoryListItem.version must be a positive integer");
  if (!NON_EMPTY_STRING(v.createdAt)) return fail("MemoryListItem.createdAt must be a non-empty string");
  if (!NON_EMPTY_STRING(v.updatedAt)) return fail("MemoryListItem.updatedAt must be a non-empty string");
  if (!isNonNegativeInteger(v.contentBytes)) return fail("MemoryListItem.contentBytes must be a non-negative integer");
  if ("tenantId" in v || "tenant_id" in v) return fail("MemoryListItem must not carry tenantId");
  if ("content" in v) return fail("MemoryListItem must not carry content");
  if ("meta" in v) return fail("MemoryListItem must not carry meta");
  return { ok: true };
}

export function validateMemoryRevisionEvent(v: unknown): SystemInspectionValidation {
  if (!isRecord(v)) return fail("MemoryRevisionEvent must be an object");
  if (!NON_EMPTY_STRING(v.entryId)) return fail("MemoryRevisionEvent.entryId must be a non-empty string");
  if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 1) return fail("MemoryRevisionEvent.revision must be a positive integer");
  if (!NON_EMPTY_STRING(v.status)) return fail("MemoryRevisionEvent.status must be a non-empty string");
  if (!NON_EMPTY_STRING(v.createdAt)) return fail("MemoryRevisionEvent.createdAt must be a non-empty string");
  if ("tenantId" in v || "content" in v || "meta" in v) return fail("MemoryRevisionEvent must not carry tenantId/content/meta");
  return { ok: true };
}

export function validateMemorySummary(v: unknown): SystemInspectionValidation {
  if (!isRecord(v)) return fail("MemorySummary must be an object");
  if (!isRecord(v.byType)) return fail("MemorySummary.byType must be an object");
  let totalCount = 0;
  let totalBytes = 0;
  for (const type of MEMORY_TYPES) {
    const entry = v.byType[type];
    if (!isRecord(entry)) return fail(`MemorySummary.byType.${type} must be an object`);
    if (!isNonNegativeInteger(entry.count)) return fail(`MemorySummary.byType.${type}.count must be a non-negative integer`);
    if (!isNonNegativeInteger(entry.bytes)) return fail(`MemorySummary.byType.${type}.bytes must be a non-negative integer`);
    totalCount += entry.count;
    totalBytes += entry.bytes;
  }
  if (!isRecord(v.totals)) return fail("MemorySummary.totals must be an object");
  if (!isNonNegativeInteger(v.totals.count) || !isNonNegativeInteger(v.totals.bytes)) {
    return fail("MemorySummary.totals.count/bytes must be non-negative integers");
  }
  if (v.totals.count !== totalCount || v.totals.bytes !== totalBytes) {
    return fail("MemorySummary.totals must equal the sum of byType counts/bytes");
  }
  return { ok: true };
}

export function validateWorkerInspection(v: unknown): SystemInspectionValidation {
  if (!isRecord(v)) return fail("WorkerInspection must be an object");
  for (const forbidden of ["prompt", "content", "secret", "environment"]) {
    if (forbidden in v) return fail(`WorkerInspection must not carry ${forbidden}`);
  }
  if (!NON_EMPTY_STRING(v.workerId)) return fail("WorkerInspection.workerId must be a non-empty string");
  if (!NON_EMPTY_STRING(v.batchId)) return fail("WorkerInspection.batchId must be a non-empty string");
  if (!isRecord(v.role) || !NON_EMPTY_STRING(v.role.roleId) || !NON_EMPTY_STRING(v.role.revision)) {
    return fail("WorkerInspection.role must contain roleId and revision");
  }
  if (!isWorkerLifecycle(v.lifecycle)) return fail(`WorkerInspection.lifecycle must be one of ${WORKER_LIFECYCLES.join(",")}`);
  if (v.workMode !== null && !isWorkMode(v.workMode)) return fail(`WorkerInspection.workMode must be one of ${WORK_MODES.join(",")} or null`);
  if (v.currentTaskId !== undefined && v.currentTaskId !== null && !NON_EMPTY_STRING(v.currentTaskId)) return fail("WorkerInspection.currentTaskId must be a string or null");
  if (v.leaseId !== undefined && v.leaseId !== null && !NON_EMPTY_STRING(v.leaseId)) return fail("WorkerInspection.leaseId must be a string or null");
  if (!isStringArray(v.regionIds)) return fail("WorkerInspection.regionIds must be a string array");
  if (!isNonNegativeWeights(v.regionWeights)) return fail("WorkerInspection.regionWeights values must be non-negative numbers");
  if (v.workingSet !== undefined) {
    const ws = validateWorkingSet(v.workingSet);
    if (!ws.ok) return ws;
  }
  if (!isStringArray(v.toolNames)) return fail("WorkerInspection.toolNames must be a string array");
  if (!isStringArray(v.skillIds)) return fail("WorkerInspection.skillIds must be a string array");
  if (v.heartbeatLagMs !== null && !isNonNegativeFiniteNumber(v.heartbeatLagMs)) return fail("WorkerInspection.heartbeatLagMs must be a non-negative number or null");
  return { ok: true };
}

export function validateRoleInspection(v: unknown): SystemInspectionValidation {
  if (!isRecord(v)) return fail("RoleInspection must be an object");
  if (!NON_EMPTY_STRING(v.roleId)) return fail("RoleInspection.roleId must be a non-empty string");
  if (!NON_EMPTY_STRING(v.revision)) return fail("RoleInspection.revision must be a non-empty string");
  if (v.parent !== undefined && v.parent !== null && !NON_EMPTY_STRING(v.parent)) return fail("RoleInspection.parent must be a string or null");
  if (v.generation !== undefined && !isNonNegativeInteger(v.generation)) return fail("RoleInspection.generation must be a non-negative integer");
  if (!isStringArray(v.tags)) return fail("RoleInspection.tags must be a string array");
  if (v.capabilities !== undefined && !isStringArray(v.capabilities)) return fail("RoleInspection.capabilities must be a string array");
  if (v.thinking !== undefined && v.thinking !== null && !["high", "medium", "low"].includes(v.thinking as string)) {
    return fail("RoleInspection.thinking must be high/medium/low or null");
  }
  if (v.acceptanceRole !== undefined && v.acceptanceRole !== null && !["read-only", "writer"].includes(v.acceptanceRole as string)) {
    return fail("RoleInspection.acceptanceRole must be read-only/writer or null");
  }
  if (v.description !== undefined && typeof v.description !== "string") return fail("RoleInspection.description must be a string");
  return { ok: true };
}

/** 五类记忆零值 summary（零记忆查询路径稳定输出）。 */
export function emptyMemorySummary(): MemorySummary {
  const zero = { count: 0, bytes: 0 };
  return {
    byType: {
      setting: { ...zero },
      wiki: { ...zero },
      skill: { ...zero },
      log: { ...zero },
      index: { ...zero },
    },
    totals: { ...zero },
  };
}
