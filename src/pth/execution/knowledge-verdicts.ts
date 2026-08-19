/**
 * knowledge-verdicts.ts — K4 Phase 4（N22 1）：候选验证 verdict 契约与纯函数。
 *
 * R3/P0-3：verdict 严格绑定不可变 candidate revision。candidate content revision
 * （memory_entries.meta.version）与 review-row version（knowledge_verdict_rows.row_version）
 * 分离；canPromote 不再读取 entry.meta.verdicts，改由 service 在锁内重读持久
 * plan + verdict rows 后调用本文件的纯函数。
 */

import { createHash } from "node:crypto";
import {
  isIntakeEvidenceReferenceShape,
  validateIntakeEvidenceReferences,
  validateKnowledgeProvenance,
  type IntakeEvidenceReference,
  type MemoryEntry,
} from "@away_from/pth-memory";

export type KnowledgeVerdictKind = "domain" | "adversarial";

export interface KnowledgeVerdict {
  kind: KnowledgeVerdictKind;
  verdict: "pass" | "reject";
  /** domain:<id> 或 controller:adversarial 或 memory-keeper */
  reviewerRole: string;
  /** 非空 */
  note: string;
  at: number;
  /** F3：签发主体（HTTP 取自 auth，能力面取自 worker 身份；不可伪造） */
  principalId?: string;
  /** F3：执行上下文（task/run id，HTTP 可缺省） */
  executionId?: string;
  /** R3：绑定 plan 的 candidateRevision——由 service 盖章，调用方不可覆盖 */
  candidateRevision?: number;
  /** F3：domain 类 verdict 必填；adversarial 不填 */
  domainId?: string;
  /** F3：可选证据——字符串数组且元素非空 */
  evidence?: string[];
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

/** 持久 VerificationPlan 的最小形状（R3/P1-2）。 */
export type VerificationPlanStatus = "open" | "satisfied" | "rejected" | "invalidated";

export interface VerificationCheckRecord {
  checkId: string;
  kind: KnowledgeVerdictKind;
  domainId?: string;
  quorum: number;
  eligiblePrincipals: string[];
  separationFrom: string[];
}

export interface VerificationPlanRecord {
  id: string;
  tenantId: string;
  candidateId: string;
  candidateRevision: number;
  candidateHash: string;
  requiredDomains: string[];
  checks: VerificationCheckRecord[];
  sourceBindingsDigest: string;
  status: VerificationPlanStatus;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** 持久 verdict row（R3/P0-3）：与 candidate content revision 分离的 review-row。 */
export interface KnowledgeVerdictRowRecord {
  id: string | number;
  planId: string;
  tenantId: string;
  checkId: string;
  candidateId: string;
  candidateRevision: number;
  candidateHash: string;
  principalId: string;
  executionId: string;
  kind: KnowledgeVerdictKind;
  verdict: "pass" | "reject";
  reviewerRole: string;
  note: string;
  domainId?: string;
  evidence: string[];
  at: number;
  rowVersion: number;
  createdAt: string;
}

/** 稳定 JSON 序列化（递归按键排序）——与 jsonb 等值语义对齐。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function toNonEmptyStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  return out;
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

/** N29 candidate 的 meta.intake 绑定（KnowledgeIngestor 盖章；调用方不可伪造出 official）。 */
export interface CandidateIntakeBinding {
  sourceSubscriptionId: string;
  sourceRevisionId: string;
  representation: "normalized-text";
  artifactHash: string;
  policyDecisionDigest: string;
  tenantId: string;
  space: string;
  domainId: string;
  producerPrincipalId: string;
  runId?: string;
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
    } else {
      adversarialPrincipals.add(row.principalId);
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

  // N29 Task 5：外部信源 candidate 的 source binding 门禁先于 hash 比较——空 digest /
  // 空 evidence / evidence 与 meta.intake 不一致 / 缺 domain+adversarial check /
  // producer 可自审 一律拒绝（旧 R3 内部 candidate 无 intake 绑定，仍走下方 digest 一致性）。
  if (isIntakeBoundCandidate(entry)) {
    const bound = checkIntakeCandidateBinding(entry, plan);
    if (!bound.ok) return bound;
  }

  const currentHash = candidateHashForEntry(entry, plan.requiredDomains);
  if (currentHash !== plan.candidateHash) {
    return { ok: false, reason: `candidateHash mismatch: entry ${currentHash} != plan ${plan.candidateHash}` };
  }

  // R5/P1-4：promotion CAS 校验 evidence 未变（R3 已留 sourceBindingsDigest 位置，本 lane 填实）。
  // 空 digest 只对无 intake 绑定的 R3 内部 candidate 有效；非空必须与当前 meta.evidence 严格一致。
  if (plan.sourceBindingsDigest !== "") {
    const rawEvidence = Array.isArray(meta["evidence"]) ? (meta["evidence"] as unknown[]) : [];
    const currentDigest = sourceBindingsDigestOf(rawEvidence);
    if (currentDigest !== plan.sourceBindingsDigest) {
      return { ok: false, reason: `sourceBindingsDigest mismatch: entry ${currentDigest} != plan ${plan.sourceBindingsDigest}` };
    }
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
