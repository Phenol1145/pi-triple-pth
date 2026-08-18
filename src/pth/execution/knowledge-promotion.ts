/**
 * knowledge-promotion.ts — K4 Phase 4（N22 2）：候选验证与晋升服务。
 *
 * - recordKnowledgeVerdict：仅 draft 可审；verdict 合法才落；同 kind+reviewer 幂等；
 *   producer 自审拒绝（reviewerRole === provenance.producerRole）。
 * - promoteKnowledgeEntry：canPromote fail-closed；write force official + meta.promotion；
 *   promoterRole 缺省 memory-keeper。
 * - rejectKnowledgeEntry：draft → verdicts 追加 reject + status archived via update（不删内容）。
 */

import { PromotionConflictError, type PgMemoryStore } from "@away_from/pth-memory";
import { canPromote, validateKnowledgeVerdict, type KnowledgeVerdict, type KnowledgeVerdictKind } from "./knowledge-verdicts.js";

function tenantOpts(opts?: { tenantId?: string }): { tenantId?: string } | undefined {
  return opts?.tenantId ? { tenantId: opts.tenantId } : undefined;
}

/**
 * 记录候选 verdict。仅 draft 可审；同 kind + reviewer 重复提交幂等返回 ok（不重复 append）；
 * producer 自审（reviewerRole === provenance.producerRole）拒绝。
 * F3：opts.principalId/executionId/domainId 作为服务端盖章写入 verdict（缺省保留调用方字段）；
 * candidateRevision 恒等于 entry.meta.version（调用方不可覆盖）。
 */
export async function recordKnowledgeVerdict(
  store: Pick<PgMemoryStore, "get" | "update">,
  entryId: string,
  verdict: KnowledgeVerdict,
  opts?: { tenantId?: string; principalId?: string; executionId?: string; domainId?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  // 先做服务端字段覆盖（body 不可自报 principalId/executionId/domainId），再统一校验形状。
  const mergedVerdict: KnowledgeVerdict = {
    ...verdict,
    ...(opts?.principalId !== undefined ? { principalId: opts.principalId } : {}),
    ...(opts?.executionId !== undefined ? { executionId: opts.executionId } : {}),
    ...(opts?.domainId !== undefined ? { domainId: opts.domainId } : {}),
  };
  const checked = validateKnowledgeVerdict(mergedVerdict);
  if (!checked.ok) return { ok: false, error: checked.error };

  const entry = await store.get(entryId, tenantOpts(opts));
  if (!entry) {
    return { ok: false, error: `entry not found in tenant ${opts?.tenantId ?? "default"}` };
  }
  if (entry.status !== "draft") {
    return { ok: false, error: "only draft knowledge can be reviewed" };
  }

  // candidateRevision 恒由 entry.meta.version 决定（调用方不可覆盖）。
  const { candidateRevision: _callerRevision, ...baseVerdict } = checked.verdict;
  const version = entry.meta?.["version"];
  const finalVerdict: KnowledgeVerdict = {
    ...baseVerdict,
    ...(typeof version === "number" ? { candidateRevision: version } : {}),
  };
  const finalCheck = validateKnowledgeVerdict(finalVerdict);
  if (!finalCheck.ok) return { ok: false, error: finalCheck.error };

  const producerRole = (entry.meta?.["provenance"] as { producerRole?: unknown } | undefined)?.producerRole;
  if (typeof producerRole === "string" && producerRole === finalCheck.verdict.reviewerRole) {
    return { ok: false, error: "producer cannot review own knowledge" };
  }
  if (typeof producerRole === "string" && finalCheck.verdict.principalId === producerRole) {
    return { ok: false, error: "producer cannot review own knowledge" };
  }

  const existing = Array.isArray(entry.meta?.["verdicts"]) ? (entry.meta["verdicts"] as unknown[]) : [];
  const duplicate = existing.some((raw) => {
    const v = raw as Record<string, unknown>;
    return v.kind === finalCheck.verdict.kind && v.reviewerRole === finalCheck.verdict.reviewerRole;
  });
  if (duplicate) return { ok: true };

  const metaPatch: Record<string, unknown> = { verdicts: [...existing, finalCheck.verdict] };
  await store.update(entryId, { meta: metaPatch }, { tenantId: opts?.tenantId });
  return { ok: true };
}

/**
 * 晋升 draft → official。canPromote fail-closed；promoterRole 缺省 "memory-keeper"。
 * P0-1：改用 PgMemoryStore.promoteOfficial 单事务 CAS 路径——canPromote 在锁内基于锁内行重算，
 * 删除原先 get → canPromote → write 的非原子窗口。expectedRevision 取自调用方读到的 candidate
 * revision（未显式传入时从 store.get 读取一次作为 CAS 基线，CAS 不匹配仍会拒绝）。
 */
export async function promoteKnowledgeEntry(
  store: Pick<PgMemoryStore, "get" | "promoteOfficial">,
  entryId: string,
  opts?: { tenantId?: string; promoterRole?: string; note?: string; principalId?: string; expectedRevision?: number },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (opts?.principalId !== undefined && (typeof opts.principalId !== "string" || opts.principalId.trim() === "")) {
    return { ok: false, error: "principalId must be a non-empty string when provided" };
  }

  const tenantId = opts?.tenantId ?? "default";
  const promoterRole = opts?.promoterRole ?? "memory-keeper";

  let expectedRevision = opts?.expectedRevision;
  if (expectedRevision === undefined) {
    // CAS 基线：未显式传入时读取当前版本作为 expectedRevision；真正的门禁在事务锁内重算。
    const entry = await store.get(entryId, tenantOpts(opts));
    if (!entry) {
      return { ok: false, error: `entry not found in tenant ${opts?.tenantId ?? "default"}` };
    }
    const version = entry.meta?.["version"];
    if (typeof version !== "number" || !Number.isFinite(version)) {
      return { ok: false, error: "entry meta.version missing for promotion CAS" };
    }
    expectedRevision = version;
  }

  const promotionMeta = {
    promotedBy: promoterRole,
    ...(opts?.principalId !== undefined ? { principalId: opts.principalId } : {}),
    ...(opts?.note !== undefined ? { note: opts.note } : {}),
    promotedAt: Date.now(),
  };

  try {
    await store.promoteOfficial(entryId, tenantId, expectedRevision, promotionMeta, {
      createdBy: promoterRole,
      reason: "knowledge-promotion",
      evaluate: canPromote,
    });
    return { ok: true, id: entryId };
  } catch (e) {
    if (e instanceof PromotionConflictError) {
      return { ok: false, error: e.message };
    }
    throw e;
  }
}

/**
 * 拒绝候选：仅 draft；meta.verdicts 追加 reject verdict + status:"archived" via update（不删内容）。
 * kind 派生：controller:adversarial → adversarial；其它 reviewerRole → domain（监督通道）。
 */
export async function rejectKnowledgeEntry(
  store: Pick<PgMemoryStore, "get" | "update">,
  entryId: string,
  reviewerRole: string,
  reason: string,
  opts?: { tenantId?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof reviewerRole !== "string" || reviewerRole.trim() === "") {
    return { ok: false, error: "reviewerRole must be a non-empty string" };
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    return { ok: false, error: "reason must be a non-empty string" };
  }

  const entry = await store.get(entryId, tenantOpts(opts));
  if (!entry) {
    return { ok: false, error: `entry not found in tenant ${opts?.tenantId ?? "default"}` };
  }
  if (entry.status !== "draft") {
    return { ok: false, error: "only draft knowledge can be rejected" };
  }

  const kind: KnowledgeVerdictKind = reviewerRole === "controller:adversarial" ? "adversarial" : "domain";
  const verdict: KnowledgeVerdict = {
    kind,
    verdict: "reject",
    reviewerRole,
    note: reason,
    at: Date.now(),
  };
  const existing = Array.isArray(entry.meta?.["verdicts"]) ? (entry.meta["verdicts"] as unknown[]) : [];
  const metaPatch: Record<string, unknown> = { verdicts: [...existing, verdict] };
  await store.update(entryId, { status: "archived", meta: metaPatch }, { tenantId: opts?.tenantId });
  return { ok: true };
}
