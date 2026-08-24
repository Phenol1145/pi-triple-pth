/**
 * knowledge-verdicts-core.ts —— K4/N29 候选验证 verdict 校验、绑定门禁与晋升判定。
 *
 * 从 `knowledge-verdicts.ts` 非破坏性拆分：verdict 校验与 promotion 纯函数集中于此。
 */

import {
  isIntakeEvidenceReferenceShape,
  validateIntakeEvidenceReferences,
  validateKnowledgeProvenance,
  type IntakeEvidenceReference,
  type MemoryEntry,
} from "@away_from/pth-memory";
import type {
  CandidateIntakeBinding,
  KnowledgeVerdict,
  KnowledgeVerdictRowRecord,
  VerificationPlanRecord,
} from "./knowledge-verdicts-types.js";
import { candidateHashForEntry, sourceBindingsDigestOf } from "./knowledge-verdicts-hash.js";

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
  // F3：optional 字段形状校验（缺省合法；提供则必须符合形状）
  if (o.principalId !== undefined && (typeof o.principalId !== "string" || o.principalId.trim() === "")) {
    return { ok: false, error: "principalId must be a non-empty string when provided" };
  }
  if (o.executionId !== undefined && (typeof o.executionId !== "string" || o.executionId.trim() === "")) {
    return { ok: false, error: "executionId must be a non-empty string when provided" };
  }
  if (o.candidateRevision !== undefined && (typeof o.candidateRevision !== "number" || !Number.isFinite(o.candidateRevision))) {
    return { ok: false, error: "candidateRevision must be a finite number when provided" };
  }
  if (o.domainId !== undefined && (typeof o.domainId !== "string" || o.domainId.trim() === "")) {
    return { ok: false, error: "domainId must be a non-empty string when provided" };
  }
  if (o.evidence !== undefined && (!Array.isArray(o.evidence) || o.evidence.some((e) => typeof e !== "string" || e.trim() === ""))) {
    return { ok: false, error: "evidence must be an array of non-empty strings when provided" };
  }
  // F3：domain verdict 必须带 domainId（adversarial 不填 domainId）
  if (o.kind === "domain" && (typeof o.domainId !== "string" || o.domainId.trim() === "")) {
    return { ok: false, error: "domain verdict requires domainId" };
  }
  return {
    ok: true,
    verdict: {
      kind: o.kind,
      verdict: o.verdict,
      reviewerRole: o.reviewerRole,
      note: o.note,
      at: o.at,
      ...(o.principalId !== undefined ? { principalId: o.principalId } : {}),
      ...(o.executionId !== undefined ? { executionId: o.executionId } : {}),
      ...(o.candidateRevision !== undefined ? { candidateRevision: o.candidateRevision } : {}),
      ...(o.domainId !== undefined ? { domainId: o.domainId } : {}),
      ...(o.evidence !== undefined ? { evidence: o.evidence } : {}),
    },
  };
}

/** 读 meta.intake（结构不合法 → undefined，不伪装绑定）。 */
export function candidateIntakeBindingOf(entry: MemoryEntry): CandidateIntakeBinding | undefined {
  const raw = entry.meta?.["intake"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const b = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  if (!str(b["sourceRevisionId"]) || !str(b["sourceSubscriptionId"])) return undefined;
  if (b["representation"] !== "normalized-text") return undefined;
  if (!str(b["artifactHash"]) || !str(b["policyDecisionDigest"])) return undefined;
  if (!str(b["tenantId"]) || !str(b["space"]) || !str(b["domainId"])) return undefined;
  if (!str(b["producerPrincipalId"])) return undefined;
  return {
    sourceSubscriptionId: b["sourceSubscriptionId"],
    sourceRevisionId: b["sourceRevisionId"],
    representation: "normalized-text",
    artifactHash: b["artifactHash"],
    policyDecisionDigest: b["policyDecisionDigest"],
    tenantId: b["tenantId"],
    space: b["space"],
    domainId: b["domainId"],
    producerPrincipalId: b["producerPrincipalId"],
    ...(str(b["runId"]) ? { runId: b["runId"] } : {}),
  };
}

/**
 * 是否为 N29 外部信源 candidate。
 *
 * 判据（任一成立）：`meta.intake` 是 KnowledgeIngestor 盖章的绑定，或 `meta.evidence`
 * 里出现任意一条 `IntakeEvidenceReference`。这类 candidate 不再享有 R3 旧计划的
 * 空 `sourceBindingsDigest` 兼容路径（plan §5 Task 5 Step 6：不保留兼容旁路）。
 */
export function isIntakeBoundCandidate(entry: MemoryEntry): boolean {
  if (entry.meta?.["intake"] !== undefined) return true;
  const evidence = entry.meta?.["evidence"];
  return Array.isArray(evidence) && evidence.some(isIntakeEvidenceReferenceShape);
}

/**
 * N29 candidate 的 evidence / source binding 门禁（fail closed）。
 * 独立导出以便 promotion service 与 plan creation 复用同一判据。
 */
export function checkIntakeCandidateBinding(
  entry: MemoryEntry,
  plan: VerificationPlanRecord,
): { ok: true; refs: IntakeEvidenceReference[]; binding: CandidateIntakeBinding } | { ok: false; reason: string } {
  // ① 空 digest 是 R3 遗留兼容路径——N29 candidate 显式拒绝（旧 plan 必须 invalidated）。
  if (plan.sourceBindingsDigest.trim() === "") {
    return {
      ok: false,
      reason:
        "N29 intake candidate requires a non-empty plan source binding digest"
        + "（empty sourceBindingsDigest is a removed legacy path; invalidate the old plan）",
    };
  }
  // ② 空 evidence / 非法 evidence 一律拒绝。
  const refs = validateIntakeEvidenceReferences(entry.meta?.["evidence"]);
  if (!refs.ok) {
    return { ok: false, reason: `N29 intake candidate evidence invalid: ${refs.error}` };
  }
  // ③ meta.intake 绑定必须存在且与 evidence 一致（revision / policy digest / artifact）。
  const binding = candidateIntakeBindingOf(entry);
  if (!binding) {
    return { ok: false, reason: "N29 intake candidate requires a well-formed meta.intake source binding" };
  }
  for (const [index, ref] of refs.refs.entries()) {
    if (ref.sourceRevisionId !== binding.sourceRevisionId) {
      return { ok: false, reason: `evidence[${index}].sourceRevisionId does not match meta.intake.sourceRevisionId` };
    }
    if (ref.sourceSubscriptionId !== binding.sourceSubscriptionId) {
      return { ok: false, reason: `evidence[${index}].sourceSubscriptionId does not match meta.intake.sourceSubscriptionId` };
    }
    if (ref.artifactHash !== binding.artifactHash) {
      return { ok: false, reason: `evidence[${index}].artifactHash does not match meta.intake.artifactHash` };
    }
    if (ref.policyDecisionDigest !== binding.policyDecisionDigest) {
      return { ok: false, reason: `evidence[${index}].policyDecisionDigest does not match meta.intake.policyDecisionDigest` };
    }
  }
  // ④ plan 必须同时包含 domain 与 adversarial 两个独立 check。
  if (!plan.checks.some((c) => c.kind === "domain")) {
    return { ok: false, reason: "N29 intake plan requires a domain check" };
  }
  if (!plan.checks.some((c) => c.kind === "adversarial")) {
    return { ok: false, reason: "N29 intake plan requires an adversarial check" };
  }
  // ⑤ producer 不得出现在任何 check 的 eligiblePrincipals（职责分离）。
  for (const check of plan.checks) {
    if (check.eligiblePrincipals.includes(binding.producerPrincipalId)) {
      return { ok: false, reason: `producer principal ${binding.producerPrincipalId} must not be eligible for check ${check.checkId}` };
    }
  }
  return { ok: true, refs: refs.refs, binding };
}

/**
 * 评估 plan + verdict rows 是否满足（不含 plan.status 门禁，供 recordKnowledgeVerdict 刷新
 * plan.status 与 canPromote 共用）。所有 verdict 必须与 plan 的 candidateRevision/candidateHash
 * 严格一致；stale/future/hash 不一致的行直接拒绝（不忽略）。
 */
export function evaluatePlanVerdicts(
  plan: VerificationPlanRecord,
  verdictRows: KnowledgeVerdictRowRecord[],
  producerRole: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (plan.checks.length === 0) {
    return { ok: false, reason: "plan must contain at least one check" };
  }

  const passByCheck = new Map<string, KnowledgeVerdictRowRecord[]>();
  const domainPrincipals = new Set<string>();
  const adversarialPrincipals = new Set<string>();
  // P1-2 修复：除 principal 分离外，domain 与 adversarial 的 executionId 也必须分离
  // ——同一执行实例不得代表两个 principal 完成双重核验。
  const domainExecutions = new Set<string>();
  const adversarialExecutions = new Set<string>();

  for (const row of verdictRows) {
    if (row.planId !== plan.id) {
      return { ok: false, reason: `verdict row planId ${row.planId} does not match plan ${plan.id}` };
    }
    if (row.candidateRevision !== plan.candidateRevision) {
      return { ok: false, reason: `verdict row candidateRevision ${row.candidateRevision} does not match plan candidate_revision ${plan.candidateRevision}` };
    }
    if (row.candidateHash !== plan.candidateHash) {
      return { ok: false, reason: "verdict row candidateHash differs from plan" };
    }
    const check = plan.checks.find((c) => c.checkId === row.checkId);
    if (!check) {
      return { ok: false, reason: `verdict row check ${row.checkId} not in plan` };
    }
    if (check.kind !== row.kind) {
      return { ok: false, reason: `verdict row kind ${row.kind} does not match check ${check.checkId} kind ${check.kind}` };
    }
    if (!check.eligiblePrincipals.includes(row.principalId)) {
      return { ok: false, reason: `principal ${row.principalId} not eligible for check ${check.checkId}` };
    }
    if (check.kind === "domain" && row.domainId !== check.domainId) {
      return { ok: false, reason: `domain verdict row domainId ${row.domainId ?? ""} does not match check ${check.checkId}` };
    }

    if (row.verdict === "reject") {
      return { ok: false, reason: "verdict rows must not contain reject" };
    }

    // producer 不能核验自己的候选；domain 与 adversarial principal 必须不同。
    if (typeof producerRole === "string" && row.principalId === producerRole) {
      return { ok: false, reason: "producer cannot review own knowledge" };
    }
    if (row.kind === "domain") {
      if (typeof row.domainId !== "string" || row.domainId.trim() === "") {
        return { ok: false, reason: "domain pass verdict requires domainId" };
      }
      domainPrincipals.add(row.principalId);
      domainExecutions.add(row.executionId);
    } else {
      adversarialPrincipals.add(row.principalId);
      adversarialExecutions.add(row.executionId);
    }

    const list = passByCheck.get(row.checkId) ?? [];
    list.push(row);
    passByCheck.set(row.checkId, list);
  }

  for (const domainPrincipal of domainPrincipals) {
    if (adversarialPrincipals.has(domainPrincipal)) {
      return { ok: false, reason: "domain and adversarial principals must differ" };
    }
  }
  for (const execution of domainExecutions) {
    if (adversarialExecutions.has(execution)) {
      return { ok: false, reason: "domain and adversarial executions must differ" };
    }
  }

  for (const check of plan.checks) {
    const passes = passByCheck.get(check.checkId) ?? [];
    if (passes.length < check.quorum) {
      return { ok: false, reason: `check ${check.checkId} quorum not satisfied (${passes.length}/${check.quorum})` };
    }
  }

  return { ok: true };
}

/**
 * 晋升门禁（fail-closed，R3/P0-3）：
 * - status === draft；
 * - meta.provenance 存在且 validateKnowledgeProvenance(meta.provenance, content) ok；
 * - meta.version（candidate content revision）与 plan.candidateRevision 严格相等；
 * - candidateHashForEntry(entry, plan.requiredDomains) 与 plan.candidateHash 严格相等；
 * - plan.status === satisfied；
 * - evaluatePlanVerdicts 逐 check quorum / separation / 无 reject / revision+hash 全一致。
 *
 * N29 再验收 P0-5（feedback §3 P0-5 / §8 条件 6）：**删除 legacy 空绑定兼容路径**。
 * 旧实现只对被识别为 intake-bound 的 candidate 强制非空 evidence/digest，legacy/内部 candidate
 * 仍可用空 `sourceBindingsDigest` + 空 `meta.evidence` 晋升成 official——那是"无来源可信"的
 * 旁路。现在**所有** candidate 都必须满足：
 *  - `plan.sourceBindingsDigest` 非空；
 *  - `meta.evidence` 是非空数组；
 *  - `sourceBindingsDigestOf(meta.evidence) === plan.sourceBindingsDigest`。
 * 内部推理知识若无外部 SourceRevision，必须显式声明内部 evidence 引用（并在 store 侧使用
 * `origin=internal` 合同），不能以"空 digest"表示可信。
 */
export function canPromote(
  entry: MemoryEntry,
  plan: VerificationPlanRecord,
  verdictRows: KnowledgeVerdictRowRecord[],
): { ok: true } | { ok: false; reason: string } {
  if (entry.status !== "draft") {
    return { ok: false, reason: "status must be draft" };
  }

  const meta = entry.meta;
  if (typeof meta !== "object" || meta === null) {
    return { ok: false, reason: "meta must be an object" };
  }

  if (plan.candidateId !== entry.id) {
    return { ok: false, reason: `plan candidate ${plan.candidateId} does not match entry ${entry.id}` };
  }

  const provenance = validateKnowledgeProvenance(meta["provenance"], entry.content);
  if (!provenance.ok) {
    return { ok: false, reason: `provenance invalid: ${provenance.error}` };
  }

  const version = meta["version"];
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return { ok: false, reason: "meta.version must be a finite number" };
  }
  if (version !== plan.candidateRevision) {
    return { ok: false, reason: `entry.meta.version ${version} does not match plan candidate_revision ${plan.candidateRevision}` };
  }

  // N29 再验收 P0-5：空 sourceBindingsDigest 是已删除的 R3 兼容路径——对**任何** candidate
  // 都必须翻红（旧 plan 必须 invalidated 后重建，不能靠空 digest 继续晋升）。
  if (plan.sourceBindingsDigest.trim() === "") {
    return {
      ok: false,
      reason:
        "official knowledge requires a non-empty plan source binding digest"
        + "（empty sourceBindingsDigest is a removed legacy path; invalidate the old plan and rebuild it）",
    };
  }
  // 空 evidence 同样一律拒绝：official 知识必须有可复核的来源绑定（外部 SourceRevision 或
  // 显式内部 evidence 引用）。
  const rawEvidence = Array.isArray(meta["evidence"]) ? (meta["evidence"] as unknown[]) : [];
  if (rawEvidence.length === 0) {
    return {
      ok: false,
      reason: "candidate meta.evidence must contain at least one source binding reference（empty evidence is a removed legacy path）",
    };
  }

  // N29 Task 5：外部信源 candidate 的 source binding 门禁先于 hash 比较——空 digest /
  // 空 evidence / evidence 与 meta.intake 不一致 / 缺 domain+adversarial check /
  // producer 可自审 一律拒绝（内部 candidate 走上方通用门禁 + 下方 digest 一致性）。
  if (isIntakeBoundCandidate(entry)) {
    const bound = checkIntakeCandidateBinding(entry, plan);
    if (!bound.ok) return bound;
  }

  const currentHash = candidateHashForEntry(entry, plan.requiredDomains);
  if (currentHash !== plan.candidateHash) {
    return { ok: false, reason: `candidateHash mismatch: entry ${currentHash} != plan ${plan.candidateHash}` };
  }

  // R5/P1-4：promotion CAS 校验 evidence 未变（digest 由上方保证非空，这里逐字节对账）。
  const currentDigest = sourceBindingsDigestOf(rawEvidence);
  if (currentDigest !== plan.sourceBindingsDigest) {
    return { ok: false, reason: `sourceBindingsDigest mismatch: entry ${currentDigest} != plan ${plan.sourceBindingsDigest}` };
  }

  if (plan.status !== "satisfied") {
    return { ok: false, reason: `plan.status must be satisfied (current: ${plan.status})` };
  }

  const producerRole = (provenance.provenance.producerRole) as string | undefined;
  const decision = evaluatePlanVerdicts(plan, verdictRows, producerRole);
  if (!decision.ok) {
    return decision;
  }

  return { ok: true };
}
