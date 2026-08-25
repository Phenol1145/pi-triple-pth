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
  ChildOutcomeEnvelopeV1,
  ChildTaskRefV1,
  DeliveryArtifactRef,
  PublisherQuestionEnvelopeV1,
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

// ─── 持久化子任务委派 V1 结构校验 ─────────────────────────────────

const SUBMISSION_KEY_PATTERN = /^[A-Za-z0-9:_@.-]+$/;
const OUTCOME_STATUSES: readonly ChildOutcomeEnvelopeV1["status"][] = ["completed", "rejected", "cancelled", "escalated"];
const CHILD_STATES: readonly ChildTaskRefV1["state"][] = ["submitted", "running", "paused", "terminal"];

export function isSubmissionKeyValid(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 128 && SUBMISSION_KEY_PATTERN.test(v);
}

export function isRequiredDependency(v: unknown): v is "required" {
  return v === undefined || v === "required";
}

export function isChildOutcomeEnvelopeStructurallyValid(v: unknown): v is ChildOutcomeEnvelopeV1 {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!OUTCOME_STATUSES.includes(o.status as ChildOutcomeEnvelopeV1["status"])) return false;
  if (typeof o.summary !== "string") return false;
  if (!Array.isArray(o.provenance) || !o.provenance.every((x) => typeof x === "string")) return false;
  if (!Array.isArray(o.artifactRefs) || !o.artifactRefs.every((x) => typeof x === "string")) return false;
  if (o.error !== undefined) {
    const e = o.error as Record<string, unknown>;
    if (typeof e !== "object" || e === null) return false;
    if (typeof e.family !== "string" || typeof e.message !== "string") return false;
    if (e.retryable !== false) return false;
  }
  return true;
}

export function isPublisherQuestionEnvelopeStructurallyValid(v: unknown): v is PublisherQuestionEnvelopeV1 {
  if (typeof v !== "object" || v === null) return false;
  const q = v as Record<string, unknown>;
  return NON_EMPTY_STRING(q.questionId) && NON_EMPTY_STRING(q.prompt) && NON_EMPTY_STRING(q.childTaskId);
}

export function isChildTaskRefStructurallyValid(v: unknown): v is ChildTaskRefV1 {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    NON_EMPTY_STRING(r.taskId) &&
    isSubmissionKeyValid(r.submissionKey) &&
    NON_EMPTY_STRING(r.roleId) &&
    isNonEmptyStringArray(r.path) &&
    CHILD_STATES.includes(r.state as ChildTaskRefV1["state"]) &&
    (r.observation === undefined || isChildOutcomeEnvelopeStructurallyValid(r.observation)) &&
    (r.question === undefined || isPublisherQuestionEnvelopeStructurallyValid(r.question))
  );
}
