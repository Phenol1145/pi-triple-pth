/**
 * knowledge-verdicts-hash.ts —— K4/N29 候选验证的 hash 纯函数。
 *
 * 从 `knowledge-verdicts.ts` 非破坏性拆分：candidateHash / sourceBindingsDigest /
 * VerificationPlanHash 等稳定序列化与摘要逻辑集中于此。
 */

import { createHash } from "node:crypto";
import {
  validateIntakeEvidenceReferences,
  type MemoryEntry,
} from "@away_from/pth-memory";

/** 稳定 JSON 序列化（递归按键排序）——与 jsonb 等值语义对齐。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** R5/P1-4：candidateHash 的 evidence 归一化——字符串保持旧语义；结构化 EvidenceRef 递归稳定序列化。 */
function normalizeEvidenceForHash(evidence: readonly unknown[]): unknown[] {
  return evidence
    .map((e) => {
      if (typeof e === "string") return e.trim();
      return e;
    })
    .filter((e) => typeof e !== "string" || e !== "");
}

/**
 * candidateHash：覆盖 content + domains + evidence（+ effect，fail-closed——effect 变化也失活）。
 * 建计划时由调用方用同一函数快照；canPromote 用 entry 当前值重算比对。
 */
export function computeCandidateHash(input: {
  content: string;
  domains: readonly string[];
  evidence: readonly unknown[];
  effect?: unknown;
}): string {
  const domains = [...new Set(input.domains.map((d) => String(d).trim()).filter((d) => d !== ""))].sort();
  const evidence = normalizeEvidenceForHash(input.evidence);
  const payload = {
    content: input.content,
    domains,
    evidence,
    effect: input.effect ?? null,
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/** R5/P1-4：sourceBindingsDigest = sha256(stableStringify(meta.evidence 归一化))。 */
export function sourceBindingsDigestOf(evidence: readonly unknown[]): string {
  return createHash("sha256")
    .update(stableStringify(normalizeEvidenceForHash(evidence)))
    .digest("hex");
}

/**
 * N29 Task 5：VerificationPlan hash——必须覆盖 content、domain、Evidence Reference、
 * policy decision digest 与 source revision。
 *
 * 实现要点：`IntakeEvidenceReference` 自身携带 `policyDecisionDigest` 与
 * `sourceRevisionId`，所以本函数先**证明覆盖**（逐条 evidence 必须携带同一
 * policy decision digest 与同一 source revision，否则抛错——不允许产出"未覆盖"的
 * plan hash），再委托 `computeCandidateHash`。这样 plan hash 与 `canPromote()`
 * 在锁内重算的 candidate hash 保持同一函数，同时可证覆盖全部五个字段。
 */
export function computeVerificationPlanHash(input: {
  content: string;
  domains: readonly string[];
  evidence: readonly unknown[];
  policyDecisionDigest: string;
  sourceRevisionId: string;
  effect?: unknown;
}): string {
  if (input.evidence.length === 0) {
    throw new Error("computeVerificationPlanHash: evidence must not be empty");
  }
  const refs = validateIntakeEvidenceReferences(input.evidence);
  if (!refs.ok) {
    throw new Error(`computeVerificationPlanHash: ${refs.error}`);
  }
  for (const [index, ref] of refs.refs.entries()) {
    if (ref.policyDecisionDigest !== input.policyDecisionDigest) {
      throw new Error(
        `computeVerificationPlanHash: evidence[${index}].policyDecisionDigest is not covered by the plan policy decision digest`,
      );
    }
    if (ref.sourceRevisionId !== input.sourceRevisionId) {
      throw new Error(
        `computeVerificationPlanHash: evidence[${index}].sourceRevisionId is not covered by the plan source revision`,
      );
    }
  }
  return computeCandidateHash({
    content: input.content,
    domains: input.domains,
    evidence: input.evidence,
    effect: input.effect ?? null,
  });
}

/** 从 entry + 计划 requiredDomains 计算当前 candidate hash（evidence/effect 取自 meta）。 */
export function candidateHashForEntry(entry: MemoryEntry, requiredDomains: readonly string[]): string {
  const meta = entry.meta ?? {};
  const rawEvidence = Array.isArray(meta["evidence"]) ? (meta["evidence"] as unknown[]) : [];
  return computeCandidateHash({
    content: entry.content,
    domains: requiredDomains,
    evidence: rawEvidence,
    effect: meta["effect"] ?? null,
  });
}
