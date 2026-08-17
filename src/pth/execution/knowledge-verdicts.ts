/**
 * knowledge-verdicts.ts — K4 Phase 4（N22 1）：候选验证 verdict 契约与纯函数。
 *
 * draft 知识候选必须取得领域 verdict + 对抗 verdict 后，由 memory-keeper 受控晋升 official；
 * 生产者不能核验自己的候选；每次晋升留痕可反查。
 */

import { validateKnowledgeProvenance, type MemoryEntry } from "@away_from/pth-memory";

export type KnowledgeVerdictKind = "domain" | "adversarial";

export interface KnowledgeVerdict {
  kind: KnowledgeVerdictKind;
  verdict: "pass" | "reject";
  /** domain:<id> 或 controller:adversarial 或 memory-keeper */
  reviewerRole: string;
  /** 非空 */
  note: string;
  at: number;
}

/** verdict 字段校验（纯函数，不依赖 store）。 */
export function validateKnowledgeVerdict(
  v: unknown,
): { ok: true; verdict: KnowledgeVerdict } | { ok: false; error: string } {
  if (typeof v !== "object" || v === null) {
    return { ok: false, error: "verdict must be an object" };
  }
  const o = v as Record<string, unknown>;
  if (o.kind !== "domain" && o.kind !== "adversarial") {
    return { ok: false, error: 'kind must be "domain" | "adversarial"' };
  }
  if (o.verdict !== "pass" && o.verdict !== "reject") {
    return { ok: false, error: 'verdict must be "pass" | "reject"' };
  }
  if (typeof o.reviewerRole !== "string" || o.reviewerRole.trim() === "") {
    return { ok: false, error: "reviewerRole must be a non-empty string" };
  }
  if (typeof o.note !== "string" || o.note.trim() === "") {
    return { ok: false, error: "note must be a non-empty string" };
  }
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) {
    return { ok: false, error: "at must be a finite number" };
  }
  return {
    ok: true,
    verdict: {
      kind: o.kind,
      verdict: o.verdict,
      reviewerRole: o.reviewerRole,
      note: o.note,
      at: o.at,
    },
  };
}

/**
 * 晋升门禁（fail-closed）：
 * - status === draft；
 * - meta.provenance 存在且 validateKnowledgeProvenance(meta.provenance, content) ok；
 * - meta.verdicts 含至少一条 domain pass 与一条 adversarial pass，且无 reject；
 * - provenance.producerRole 不得等于任一 pass verdict 的 reviewerRole；
 * - domain reviewer 与 adversarial reviewer 不得相同。
 */
export function canPromote(entry: MemoryEntry): { ok: true } | { ok: false; reason: string } {
  if (entry.status !== "draft") {
    return { ok: false, reason: "status must be draft" };
  }

  const meta = entry.meta;
  if (typeof meta !== "object" || meta === null) {
    return { ok: false, reason: "meta must be an object" };
  }

  const provenance = validateKnowledgeProvenance(meta["provenance"], entry.content);
  if (!provenance.ok) {
    return { ok: false, reason: `provenance invalid: ${provenance.error}` };
  }

  const verdicts = meta["verdicts"];
  if (!Array.isArray(verdicts)) {
    return { ok: false, reason: "meta.verdicts must be an array" };
  }

  const passVerdicts: KnowledgeVerdict[] = [];
  for (const raw of verdicts) {
    const checked = validateKnowledgeVerdict(raw);
    if (!checked.ok) {
      return { ok: false, reason: `invalid verdict: ${checked.error}` };
    }
    if (checked.verdict.verdict === "reject") {
      return { ok: false, reason: "verdicts must not contain reject" };
    }
    passVerdicts.push(checked.verdict);
  }

  const domainReviewers = new Set(
    passVerdicts.filter((v) => v.kind === "domain").map((v) => v.reviewerRole),
  );
  const adversarialReviewers = new Set(
    passVerdicts.filter((v) => v.kind === "adversarial").map((v) => v.reviewerRole),
  );

  if (domainReviewers.size === 0) {
    return { ok: false, reason: "missing domain pass verdict" };
  }
  if (adversarialReviewers.size === 0) {
    return { ok: false, reason: "missing adversarial pass verdict" };
  }

  const producerRole = provenance.provenance.producerRole;
  for (const pass of passVerdicts) {
    if (pass.reviewerRole === producerRole) {
      return { ok: false, reason: "producer cannot review own knowledge" };
    }
  }

  for (const domainReviewer of domainReviewers) {
    if (adversarialReviewers.has(domainReviewer)) {
      return { ok: false, reason: "domain and adversarial reviewers must differ" };
    }
  }

  return { ok: true };
}
