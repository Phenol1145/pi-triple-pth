/**
 * contracts/notebook-guide.ts — v1.3 Task 9 可执行 Jupyter 教程契约（纯类型 + 结构校验）。
 *
 * Notebook 是教学投影，不是知识或执行事实源。每份 Notebook 必须绑定：
 *  - 至少一个源专业 Job（sourceJobIds 非空）与其 artifact sha256；
 *  - kernel 与 committed runtime lock hash；
 *  - 草稿 notebookHash 与本轮 executedNotebookHash（历史输出不能替代本轮执行记录，
 *    因此非 draft 状态必须有 executedNotebookHash）；
 *  - 租户边界：校验时显式比对 expectedTenantId，跨租户拒绝。
 *
 * 本文件不 import fastify / pg / redis / 运行时实现。
 */

import { isIsoDateString } from "./identity.js";

// ─── Manifest ──────────────────────────────────────────────────────────────

export const NOTEBOOK_GUIDE_STATUSES = ["draft", "executed", "reviewed", "rejected"] as const;
export type NotebookGuideStatus = (typeof NOTEBOOK_GUIDE_STATUSES)[number];

export interface NotebookGuideManifest {
  readonly notebookId: string;
  readonly title: string;
  readonly tenantId: string;
  readonly educatorRoleRevision: string;
  readonly reviewerRoleRevision: string;
  readonly sourceJobIds: readonly string[];
  readonly sourceArtifactHashes: readonly string[];
  readonly kernelId: string;
  readonly runtimeLockHash: string;
  readonly notebookHash: string;
  /** draft 阶段为 null；executed/reviewed/rejected 必须是本轮执行的 sha256。 */
  readonly executedNotebookHash: string | null;
  readonly status: NotebookGuideStatus;
}

export type NotebookGuideManifestValidationResult =
  | { ok: true; value: NotebookGuideManifest }
  | { ok: false; reason: string };

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;
const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSha256Digest(v: unknown): v is string {
  return NON_EMPTY_STRING(v) && SHA256_DIGEST_RE.test(v);
}

export function validateNotebookGuideManifest(
  v: unknown,
  opts: { expectedTenantId?: string } = {},
): NotebookGuideManifestValidationResult {
  if (!isObject(v)) return { ok: false, reason: "manifest must be an object" };
  if (!NON_EMPTY_STRING(v.notebookId)) return { ok: false, reason: "notebookId is required" };
  if (!NON_EMPTY_STRING(v.title)) return { ok: false, reason: "title is required" };
  if (!NON_EMPTY_STRING(v.tenantId)) return { ok: false, reason: "tenantId is required" };
  if (opts.expectedTenantId !== undefined && v.tenantId !== opts.expectedTenantId) {
    return { ok: false, reason: `tenant mismatch: ${v.tenantId} != ${opts.expectedTenantId}` };
  }
  if (!NON_EMPTY_STRING(v.educatorRoleRevision)) return { ok: false, reason: "educatorRoleRevision is required" };
  if (!NON_EMPTY_STRING(v.reviewerRoleRevision)) return { ok: false, reason: "reviewerRoleRevision is required" };
  if (!Array.isArray(v.sourceJobIds) || v.sourceJobIds.length === 0) {
    return { ok: false, reason: "sourceJobIds must bind at least one source job" };
  }
  if (!v.sourceJobIds.every((id) => NON_EMPTY_STRING(id))) {
    return { ok: false, reason: "sourceJobIds entries must be non-empty strings" };
  }
  if (!Array.isArray(v.sourceArtifactHashes) || v.sourceArtifactHashes.length === 0) {
    return { ok: false, reason: "sourceArtifactHashes must bind at least one artifact hash" };
  }
  if (!v.sourceArtifactHashes.every((h) => isSha256Digest(h))) {
    return { ok: false, reason: "sourceArtifactHashes entries must be sha256:<64 hex chars>" };
  }
  if (!NON_EMPTY_STRING(v.kernelId)) return { ok: false, reason: "kernelId is required" };
  if (!isSha256Digest(v.runtimeLockHash)) return { ok: false, reason: "runtimeLockHash must be sha256:<64 hex chars>" };
  if (!isSha256Digest(v.notebookHash)) return { ok: false, reason: "notebookHash must be sha256:<64 hex chars>" };
  if (v.executedNotebookHash !== null && !isSha256Digest(v.executedNotebookHash)) {
    return { ok: false, reason: "executedNotebookHash must be null or sha256:<64 hex chars>" };
  }
  if (typeof v.status !== "string" || !(NOTEBOOK_GUIDE_STATUSES as readonly string[]).includes(v.status)) {
    return { ok: false, reason: `status must be one of ${NOTEBOOK_GUIDE_STATUSES.join(", ")}` };
  }
  if (v.status !== "draft" && v.executedNotebookHash === null) {
    return { ok: false, reason: "non-draft status requires this run's executedNotebookHash" };
  }
  return { ok: true, value: v as unknown as NotebookGuideManifest };
}

// ─── 领域复核签名（technical-educator 不得自签技术正确性） ──────────────────

export const TECHNICAL_EDUCATOR_ROLE_ID = "technical-educator";

export interface NotebookGuideDomainReview {
  readonly notebookId: string;
  /** 复核者 Role（必须是对应专业 Role，绝不能是 technical-educator 自签）。 */
  readonly reviewerRoleId: string;
  readonly reviewerRoleRevision: string;
  readonly approved: boolean;
  readonly reviewedAt: string;
  readonly note?: string;
}

export type NotebookGuideDomainReviewValidationResult =
  | { ok: true; value: NotebookGuideDomainReview }
  | { ok: false; reason: string };

export function validateNotebookGuideDomainReview(
  review: unknown,
  manifest: NotebookGuideManifest,
): NotebookGuideDomainReviewValidationResult {
  if (!isObject(review)) return { ok: false, reason: "review must be an object" };
  if (!NON_EMPTY_STRING(review.notebookId)) return { ok: false, reason: "notebookId is required" };
  if (review.notebookId !== manifest.notebookId) {
    return { ok: false, reason: `review notebookId ${review.notebookId} does not match manifest ${manifest.notebookId}` };
  }
  if (!NON_EMPTY_STRING(review.reviewerRoleId)) return { ok: false, reason: "reviewerRoleId is required" };
  if (review.reviewerRoleId === TECHNICAL_EDUCATOR_ROLE_ID) {
    return { ok: false, reason: "technical-educator cannot self-approve technical correctness" };
  }
  if (!NON_EMPTY_STRING(review.reviewerRoleRevision)) return { ok: false, reason: "reviewerRoleRevision is required" };
  if (review.reviewerRoleRevision !== manifest.reviewerRoleRevision) {
    return { ok: false, reason: "reviewerRoleRevision must match manifest.reviewerRoleRevision" };
  }
  if (typeof review.approved !== "boolean") return { ok: false, reason: "approved must be a boolean" };
  if (!isIsoDateString(review.reviewedAt)) return { ok: false, reason: "reviewedAt must be an ISO-8601 timestamp" };
  if (review.note !== undefined && typeof review.note !== "string") return { ok: false, reason: "note must be a string" };
  return { ok: true, value: review as unknown as NotebookGuideDomainReview };
}
