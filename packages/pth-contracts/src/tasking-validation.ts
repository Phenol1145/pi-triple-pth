/**
 * contracts/tasking-validation.ts — 任务认领/执行/提交协议的结构校验。
 *
 * 从 `tasking.ts` 非破坏性拆分：结构谓词集中于此。
 */

import {
  isTenantScopeStructurallyValid,
  isUuidLike,
  isWorkspaceRefStructurallyValid,
} from "./identity.js";
import { validateDomainBinding, type DomainBinding } from "./domains.js";
import { isWorkMode } from "./work-mode.js";
import type {
  ArtifactRef,
  DeliveryArtifactRef,
  TaskDelivery,
  TaskLease,
  TaskLeaseReference,
  TaskOutcome,
  TaskOutcomeStatus,
  TaskWorkItem,
} from "./tasking-types.js";
import { DELIVERY_ARTIFACT_KINDS } from "./tasking-types.js";

const STATUSES: readonly TaskOutcomeStatus[] = ["completed", "rejected", "cancelled"];
const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function isNonEmptyStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.length > 0 && v.every(NON_EMPTY_STRING);
}

export function isTaskLeaseReferenceStructurallyValid(v: unknown): v is TaskLeaseReference {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  return (
    NON_EMPTY_STRING(l.taskId) &&
    isUuidLike(l.leaseId) &&
    typeof l.generation === "number" &&
    Number.isInteger(l.generation) &&
    l.generation > 0
  );
}

export function isTaskLeaseStructurallyValid(v: unknown): v is TaskLease {
  if (!isTaskLeaseReferenceStructurallyValid(v)) return false;
  const l = v as unknown as Record<string, unknown>;
  return (
    isTenantScopeStructurallyValid(l.scope) &&
    isWorkspaceRefStructurallyValid(l.workspace) &&
    NON_EMPTY_STRING(l.roleId) &&
    typeof l.deadlineAt === "string" &&
    Number.isFinite(Date.parse(l.deadlineAt))
  );
}

export function isTaskWorkItemStructurallyValid(v: unknown): v is TaskWorkItem {
  if (typeof v !== "object" || v === null) return false;
  const w = v as Record<string, unknown>;
  const domainsOk = Array.isArray(w.domains) && w.domains.every((d) => NON_EMPTY_STRING(d));
  return (
    NON_EMPTY_STRING(w.taskId) &&
    isTenantScopeStructurallyValid(w.scope) &&
    typeof w.title === "string" &&
    typeof w.text === "string" &&
    Array.isArray(w.tags) &&
    w.tags.every((t) => NON_EMPTY_STRING(t)) &&
    NON_EMPTY_STRING(w.assignedRole) &&
    domainsOk &&
    (w.domainBinding === undefined ||
      (domainsOk && validateDomainBinding(w.domainBinding as DomainBinding, new Set(w.domains as readonly string[])).ok)) &&
    (w.workMode === undefined || isWorkMode(w.workMode))
  );
}

export function isArtifactRefStructurallyValid(v: unknown): v is { kind: string; uri: string; mediaType?: string } {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  if (!NON_EMPTY_STRING(a.kind) || !NON_EMPTY_STRING(a.uri)) return false;
  if (a.mediaType !== undefined && typeof a.mediaType !== "string") return false;
  return true;
}

export function isTaskOutcomeStructurallyValid(v: unknown): v is TaskOutcome {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!isTaskLeaseReferenceStructurallyValid(o.lease)) return false;
  if (!STATUSES.includes(o.status as TaskOutcomeStatus)) return false;
  if (o.retryable !== undefined && typeof o.retryable !== "boolean") return false;
  if (!Array.isArray(o.artifacts) || !o.artifacts.every(isArtifactRefStructurallyValid)) return false;
  if (o.error !== undefined) {
    const e = o.error as Record<string, unknown>;
    if (typeof e !== "object" || e === null || !NON_EMPTY_STRING(e.code) || typeof e.message !== "string") return false;
  }
  if (o.usage !== undefined && (typeof o.usage !== "object" || o.usage === null || Object.values(o.usage).some((n) => typeof n !== "number" || !Number.isFinite(n)))) return false;
  if (!NON_EMPTY_STRING(o.traceId)) return false;
  return true;
}

export function isDeliveryArtifactRefStructurallyValid(v: unknown): v is DeliveryArtifactRef {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    DELIVERY_ARTIFACT_KINDS.includes(a.kind as DeliveryArtifactRef["kind"]) &&
    NON_EMPTY_STRING(a.id)
  );
}

export function isTaskDeliveryStructurallyValid(v: unknown): v is TaskDelivery {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  if (!isNonEmptyStringArray(d.path) || !NON_EMPTY_STRING(d.lineageId)) return false;
  if (d.parent !== undefined) {
    const p = d.parent as Record<string, unknown>;
    if (
      typeof p !== "object" || p === null ||
      !NON_EMPTY_STRING(p.taskId) || !NON_EMPTY_STRING(p.roleId) ||
      !isNonEmptyStringArray(p.typePath)
    ) return false;
  }
  if (d.replyTo !== undefined && d.replyTo !== "parent" && d.replyTo !== "caller") return false;
  if (d.artifactRef !== undefined && !isDeliveryArtifactRefStructurallyValid(d.artifactRef)) return false;
  if (d.goal !== undefined && !NON_EMPTY_STRING(d.goal)) return false;
  return true;
}
