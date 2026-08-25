/**
 * contracts/tasking-utils.ts — 任务提交/投递/结果编码的纯工具函数。
 *
 * 从 `tasking.ts` 非破坏性拆分：commit tenant 解析、delivery 盖章与 result 编码集中于此。
 */

import { Buffer } from "node:buffer";
import { isTenantScopeStructurallyValid, type TenantScope } from "./identity.js";
import type {
  ArtifactRef,
  DeliveryArtifactRef,
  EncodedTaskResult,
  TaskCommitOptions,
  TaskCommitSideEffect,
  TaskDelivery,
  TaskOutcome,
  TaskResultWriteback,
} from "./tasking-types.js";
import {
  DELIVERY_ARTIFACT_KINDS,
  TASK_DELIVERY_PAYLOAD_KEY,
  TASK_RESULT_MAX_BYTES,
} from "./tasking-types.js";
import { isArtifactRefStructurallyValid } from "./tasking-validation.js";

const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * N29 再验收 P0-1：side effect 自报 tenant 与服务端盖章 tenant 是否冲突。
 *
 * 冲突判据只有一条——**提供了非空 tenantId 且不等于聚合 tenant**。缺省不算冲突（由仓库盖章）。
 * 仓库必须在开启事务前调用本判据，冲突时 fail closed（不提交、零 side effect）。
 */
export function hasForeignTenantSideEffect(
  stampedTenantId: string,
  sideEffects?: ReadonlyArray<TaskCommitSideEffect>,
): boolean {
  if (!sideEffects || sideEffects.length === 0) return false;
  return sideEffects.some((se) => NON_EMPTY_STRING(se.tenantId) && se.tenantId !== stampedTenantId);
}

/**
 * 解析 commit 的服务端 tenant scope（N29 P0-2）。
 *
 * 优先级：
 *  1. `opts.scope.tenantId`——装配点（dispatcher）从 claim 返回的 lease 盖章；
 *  2. `outcome.lease` 为完整服务端 `TaskLease` 时取 `lease.scope.tenantId`
 *     （claim() 的返回值本身即服务端签发对象；内部/测试调用方直接回传时可用）；
 *  3. 都没有 → `null`：调用方必须 fail closed（不提交、不写 side effect）。
 *
 * 任一来源的 tenant 都只会被 AND 进 CAS 谓词（只能收窄不能放宽）：错 tenant 的结果是
 * committed=false，不存在跨租户提交。
 */
export function resolveTaskCommitTenantId(outcome: TaskOutcome, opts?: TaskCommitOptions): string | null {
  const stamped = opts?.scope?.tenantId;
  if (NON_EMPTY_STRING(stamped)) return stamped;
  const lease = outcome.lease as unknown as { scope?: unknown };
  if (isTenantScopeStructurallyValid(lease.scope)) return (lease.scope as TenantScope).tenantId;
  return null;
}

export function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * 服务器端入口盖章：path=[assignedRole]、lineageId=自身 taskId、不设 parent。
 * goal 可选：入口发布者显式提供时盖章；未提供则省略。
 * 仅当 taskId 与 assignedRole 均有效时返回；否则返回 null（调用方决定拒绝或降级）。
 */
export function buildEntryDelivery(taskId: string, roleId: string, goal?: string): TaskDelivery | null {
  if (!NON_EMPTY_STRING(taskId) || !NON_EMPTY_STRING(roleId)) return null;
  return NON_EMPTY_STRING(goal)
    ? { path: [roleId], lineageId: taskId, goal }
    : { path: [roleId], lineageId: taskId };
}

/** 把入口 delivery 合入 payload 的 `delivery` 键；payload 非普通对象时先归一化为对象。 */
export function attachEntryDelivery(payload: unknown, taskId: string, roleId: string, goal?: string): Record<string, unknown> {
  const base = isPlainRecord(payload) ? { ...payload } : {};
  const delivery = buildEntryDelivery(taskId, roleId, goal);
  if (delivery) base[TASK_DELIVERY_PAYLOAD_KEY] = delivery;
  return base;
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function jsonBytes(v: unknown): number | undefined {
  try {
    return utf8Bytes(JSON.stringify(v));
  } catch {
    return undefined;
  }
}

function buildUnserializableFallback(v: unknown): Record<string, unknown> {
  return {
    __pthUnserializable: true,
    type: typeof v,
    preview: String(v).slice(0, 2000),
  };
}

const CLIP_MARKER = "…（已截断）";

function clipStringValue(s: string, budget: number): string {
  const whole = utf8Bytes(JSON.stringify(s));
  if (whole <= budget) return s;
  // 二分找最大前缀：prefix + 截断标记 序列化后仍 ≤ budget
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(JSON.stringify(s.slice(0, mid) + CLIP_MARKER)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + CLIP_MARKER;
}

interface ClippedValue {
  value: unknown;
  unserializable: boolean;
  /** 本值或其任意后代被截断（不一定有空间追加 __pthTruncated 标记） */
  truncated: boolean;
}

function clipJsonValue(v: unknown, budget: number): ClippedValue {
  if (typeof v === "string") {
    const whole = utf8Bytes(JSON.stringify(v));
    return whole <= budget
      ? { value: v, unserializable: false, truncated: false }
      : { value: clipStringValue(v, budget), unserializable: false, truncated: true };
  }
  if (v === null || typeof v === "boolean" || typeof v === "number") {
    return (jsonBytes(v) ?? Infinity) <= budget
      ? { value: v, unserializable: false, truncated: false }
      : { value: null, unserializable: false, truncated: false };
  }
  if (typeof v === "undefined" || typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
    return { value: `[unserializable:${typeof v}]`, unserializable: true, truncated: false };
  }
  if (Array.isArray(v)) return clipArrayValue(v, budget);
  if (isPlainRecord(v)) return clipRecordValue(v, budget);
  // Date/Map/Set/类实例等非普通对象：JSON.stringify 会静默丢字段——降级为摘要字符串
  return { value: String(v).slice(0, 2000), unserializable: false, truncated: false };
}

/** 截断标记对象（末位追加；预算不足时不追加，但 truncated 语义仍由调用方判断） */
function clipArrayValue(arr: readonly unknown[], budget: number): ClippedValue {
  const out: unknown[] = [];
  let used = 2; // []
  let unserializable = false;
  let truncated = false;
  let omitted = 0;
  for (const item of arr) {
    const remaining = budget - used;
    if (remaining <= 0) { omitted++; continue; }
    const clipped = clipJsonValue(item, remaining);
    const candidate = [...out, clipped.value];
    const candidateBytes = jsonBytes(candidate);
    if (candidateBytes === undefined || candidateBytes > budget) { omitted++; continue; }
    out.push(clipped.value);
    used = candidateBytes;
    unserializable ||= clipped.unserializable;
    truncated ||= clipped.truncated;
  }
  if (omitted > 0 || truncated) {
    const marker = { __pthTruncated: true, ...(omitted > 0 ? { omittedItems: omitted } : {}) };
    const withMarker = [...out, marker];
    if ((jsonBytes(withMarker) ?? Infinity) <= budget) out.push(marker);
  }
  return { value: out, unserializable, truncated: truncated || omitted > 0 };
}

function clipRecordValue(rec: Record<string, unknown>, budget: number): ClippedValue {
  const out: Record<string, unknown> = {};
  let used = 2; // {}
  let unserializable = false;
  let truncated = false;
  let omitted = 0;
  for (const [key, item] of Object.entries(rec)) {
    const keyBytes = jsonBytes(key) ?? 16;
    const remaining = budget - used - keyBytes;
    if (remaining <= 0) { omitted++; continue; }
    const clipped = clipJsonValue(item, remaining);
    const candidate = { ...out, [key]: clipped.value };
    const candidateBytes = jsonBytes(candidate);
    if (candidateBytes === undefined || candidateBytes > budget) { omitted++; continue; }
    out[key] = clipped.value;
    used = candidateBytes;
    unserializable ||= clipped.unserializable;
    truncated ||= clipped.truncated;
  }
  if (omitted > 0 || truncated) {
    const truncatedMarker = { ...out, __pthTruncated: true };
    if ((jsonBytes(truncatedMarker) ?? Infinity) <= budget) out.__pthTruncated = true;
    if (omitted > 0) {
      const countedMarker = { ...out, __pthOmittedKeys: omitted };
      if ((jsonBytes(countedMarker) ?? Infinity) <= budget) out.__pthOmittedKeys = omitted;
    }
  }
  return { value: out, unserializable, truncated: truncated || omitted > 0 };
}

/**
 * done.result → payload.result 编码（用户裁决 Q3 方案 1）：
 *  - 可 JSON 序列化且 ≤64KiB：原值 round-trip（结构保留）；
 *  - 超限：递归截断容器/字符串并带 __pthTruncated 标记；
 *  - 不可序列化（循环引用/函数/BigInt 根值等）：降级为错误摘要对象，不抛错。
 */
export function encodeResultForPayload(input: unknown, maxBytes: number = TASK_RESULT_MAX_BYTES): EncodedTaskResult {
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    json = undefined;
  }
  if (json !== undefined) {
    const bytes = utf8Bytes(json);
    if (bytes <= maxBytes) {
      return { value: JSON.parse(json) as unknown, truncated: false, unserializable: false };
    }
    const clipped = clipJsonValue(input, maxBytes);
    return { value: clipped.value, truncated: true, unserializable: clipped.unserializable };
  }
  // JSON.stringify 返回 undefined 且不抛错：root 为 undefined/function/symbol
  return { value: buildUnserializableFallback(input), truncated: false, unserializable: true };
}

/** 把 runner ArtifactRef 映射为 TaskDelivery.artifactRef（kind 必须在 memory/file/component 白名单内） */
export function toDeliveryArtifactRef(ref: ArtifactRef | undefined): DeliveryArtifactRef | null {
  if (!ref || !isArtifactRefStructurallyValid(ref)) return null;
  if (!DELIVERY_ARTIFACT_KINDS.includes(ref.kind as DeliveryArtifactRef["kind"])) return null;
  return { kind: ref.kind as DeliveryArtifactRef["kind"], id: ref.uri };
}

export function buildCompletedResultWriteback(
  result: unknown,
  artifacts: readonly ArtifactRef[],
  maxBytes: number = TASK_RESULT_MAX_BYTES,
): TaskResultWriteback {
  const encoded = encodeResultForPayload(result, maxBytes);
  return { result: encoded.value, artifactRef: toDeliveryArtifactRef(artifacts[0]) };
}

export function buildErrorResultWriteback(
  error: { code: string; message: string } | undefined,
  defaultMessage = "任务被拒绝",
): TaskResultWriteback {
  return {
    result: { error: error ?? { code: "rejected", message: defaultMessage } },
    artifactRef: null,
  };
}
