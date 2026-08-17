/**
 * knowledge-promotion.ts — K4 Phase 4（N22 2）：候选验证与晋升服务。
 *
 * - recordKnowledgeVerdict：仅 draft 可审；verdict 合法才落；同 kind+reviewer 幂等；
 *   producer 自审拒绝（reviewerRole === provenance.producerRole）。
 * - promoteKnowledgeEntry：canPromote fail-closed；write force official + meta.promotion；
 *   promoterRole 缺省 memory-keeper。
 * - rejectKnowledgeEntry：draft → verdicts 追加 reject + status archived via update（不删内容）。
 */

import type { PgMemoryStore } from "@away_from/pth-memory";
import { canPromote, validateKnowledgeVerdict, type KnowledgeVerdict, type KnowledgeVerdictKind } from "./knowledge-verdicts.js";

function tenantOpts(opts?: { tenantId?: string }): { tenantId?: string } | undefined {
  return opts?.tenantId ? { tenantId: opts.tenantId } : undefined;
}

/**
 * 记录候选 verdict。仅 draft 可审；同 kind + reviewer 重复提交幂等返回 ok（不重复 append）；
 * producer 自审（reviewerRole === provenance.producerRole）拒绝。
 */
export async function recordKnowledgeVerdict(
  store: Pick<PgMemoryStore, "get" | "update">,
  entryId: string,
  verdict: KnowledgeVerdict,
  opts?: { tenantId?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const checked = validateKnowledgeVerdict(verdict);
  if (!checked.ok) return { ok: false, error: checked.error };

  const entry = await store.get(entryId, tenantOpts(opts));
  if (!entry) {
    return { ok: false, error: `entry not found in tenant ${opts?.tenantId ?? "default"}` };
  }
  if (entry.status !== "draft") {
    return { ok: false, error: "only draft knowledge can be reviewed" };
  }

  const producerRole = (entry.meta?.["provenance"] as { producerRole?: unknown } | undefined)?.producerRole;
  if (typeof producerRole === "string" && producerRole === checked.verdict.reviewerRole) {
    return { ok: false, error: "producer cannot review own knowledge" };
  }

  const existing = Array.isArray(entry.meta?.["verdicts"]) ? (entry.meta["verdicts"] as unknown[]) : [];
  const duplicate = existing.some((raw) => {
    const v = raw as Record<string, unknown>;
    return v.kind === checked.verdict.kind && v.reviewerRole === checked.verdict.reviewerRole;
  });
  if (duplicate) return { ok: true };

  const metaPatch: Record<string, unknown> = { verdicts: [...existing, checked.verdict] };
  await store.update(entryId, { meta: metaPatch }, { tenantId: opts?.tenantId });
  return { ok: true };
}

/**
 * 晋升 draft → official。canPromote fail-closed；promoterRole 缺省 "memory-keeper"。
 * 写入 meta.promotion = { promotedBy, promotedAt, verdicts }（留痕可反查）；
 * write 走 force 系统通道（official 后 K1b provenance 门禁自然再次校验）。
 */
export async function promoteKnowledgeEntry(
  store: Pick<PgMemoryStore, "get" | "write">,
  entryId: string,
  opts?: { tenantId?: string; promoterRole?: string; note?: string },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const entry = await store.get(entryId, tenantOpts(opts));
  if (!entry) {
    return { ok: false, error: `entry not found in tenant ${opts?.tenantId ?? "default"}` };
  }

  const decision = canPromote(entry);
  if (!decision.ok) return { ok: false, error: decision.reason };

  const promoterRole = opts?.promoterRole ?? "memory-keeper";
  const verdicts = entry.meta?.verdicts;
  await store.write(
    {
      ...entry,
      status: "official",
      tenantId: opts?.tenantId ?? entry.tenantId,
      meta: {
        ...entry.meta,
        promotion: {
          promotedBy: promoterRole,
          promotedAt: Date.now(),
          verdicts,
        },
      },
    },
    { force: true, reason: "knowledge-promotion", createdBy: promoterRole },
  );
  return { ok: true, id: entryId };
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
