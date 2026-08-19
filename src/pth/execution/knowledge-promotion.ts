/**
 * knowledge-promotion.ts — K4 Phase 4（N22 2）：候选验证与晋升服务。
 *
 * R3/P0-3 + P1-2：
 * - recordKnowledgeVerdict / promoteKnowledgeEntry 的 auth 上下文必填（无缺省、无可选）；
 * - verdict 落持久 knowledge_verdict_rows（不再 append entry.meta.verdicts）；
 * - recordKnowledgeVerdict 只接受 planId + checkId + expectedCandidateRevision，服务端与
 *   plan.candidate_revision 严格比对（stale/future 一律拒绝）；
 * - promoteKnowledgeEntry 只接受 planId + expectedCandidateRevision，走 R1 单事务 CAS，
 *   并在锁内用同一 client 重读 plan/verdict rows 确认 satisfied 后才写 official + 索引 outbox。
 */

import type pg from "pg";
import { PromotionConflictError, type PgMemoryStore } from "@away_from/pth-memory";
// N29/P0-3：outbox 身份为 (tenant_id, key) + 稳定 payload_hash——晋升索引行改用同一事务绑定
// enqueue（不再自写 `ON CONFLICT (key) DO NOTHING`：既避免跨 tenant 撞 key 静默丢弃，
// 也让不同 payload 的同 key 显式 conflict 并回滚整个晋升事务）。
import { enqueueSideEffectInTx } from "../tasking/index.js";
import {
  canPromote,
  candidateIntakeBindingOf,
  computeVerificationPlanHash,
  evaluatePlanVerdicts,
  isIntakeBoundCandidate,
  sourceBindingsDigestOf,
  validateKnowledgeVerdict,
  type CandidateIntakeBinding,
  type KnowledgeVerdict,
  type KnowledgeVerdictKind,
  type KnowledgeVerdictRowRecord,
  type VerificationCheckRecord,
  type VerificationPlanRecord,
  type VerificationPlanStatus,
} from "./knowledge-verdicts.js";
import { validateIntakeEvidenceReferences } from "@away_from/pth-memory";

export interface KnowledgeServiceAuth {
  principalId: string;
  executionId: string;
  roleId?: string;
  grantId?: string;
}

export type KnowledgeVerificationQueryable = pg.Pool | pg.PoolClient;

/** R3/P1-2：持久 VerificationPlan/verdict rows 的窄端口。 */
export interface KnowledgeVerificationRepo {
  getPlan(planId: string, tenantId: string, executor?: KnowledgeVerificationQueryable): Promise<VerificationPlanRecord | undefined>;
  listVerdictRows(planId: string, tenantId: string, executor?: KnowledgeVerificationQueryable): Promise<KnowledgeVerdictRowRecord[]>;
  insertVerdictRow(
    row: Omit<KnowledgeVerdictRowRecord, "id" | "rowVersion" | "createdAt">,
    executor?: KnowledgeVerificationQueryable,
  ): Promise<{ ok: true; idempotent: boolean } | { ok: false; error: string }>;
  setPlanStatus(planId: string, tenantId: string, status: VerificationPlanStatus, executor?: KnowledgeVerificationQueryable): Promise<void>;
}

function tenantOpts(opts?: { tenantId?: string }): { tenantId?: string } | undefined {
  return opts?.tenantId ? { tenantId: opts.tenantId } : undefined;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** 稳定 JSON（递归键排序）——jsonb 会重排对象键，比较必须用规范形式而非 JSON.stringify。 */
function stableJsonOf(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonOf).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJsonOf(rec[k])}`)
    .join(",")}}`;
}

function isValidAuth(auth: KnowledgeServiceAuth | undefined): auth is KnowledgeServiceAuth {
  if (!auth) return false;
  if (!isNonEmptyString(auth.principalId)) return false;
  if (!isNonEmptyString(auth.executionId)) return false;
  if (auth.roleId !== undefined && !isNonEmptyString(auth.roleId)) return false;
  if (auth.grantId !== undefined && !isNonEmptyString(auth.grantId)) return false;
  return true;
}

/** 同一 (plan_id, check_id, principal_id) 幂等比较：payload 全同 → idempotent；否则 conflict。 */
function sameVerdictPayload(
  a: Omit<KnowledgeVerdictRowRecord, "id" | "rowVersion" | "createdAt"> | KnowledgeVerdictRowRecord,
  b: Omit<KnowledgeVerdictRowRecord, "id" | "rowVersion" | "createdAt">,
): boolean {
  const normalizeEvidence = (v: string[] | undefined): string[] =>
    Array.isArray(v) ? v.map((e) => e.trim()).filter((e) => e !== "") : [];
  return a.planId === b.planId
    && a.tenantId === b.tenantId
    && a.checkId === b.checkId
    && a.candidateId === b.candidateId
    && a.candidateRevision === b.candidateRevision
    && a.candidateHash === b.candidateHash
    && a.principalId === b.principalId
    && a.executionId === b.executionId
    && a.kind === b.kind
    && a.verdict === b.verdict
    && a.reviewerRole === b.reviewerRole
    && a.note === b.note
    && (a.domainId ?? null) === (b.domainId ?? null)
    && JSON.stringify(normalizeEvidence(a.evidence)) === JSON.stringify(normalizeEvidence(b.evidence))
    && a.at === b.at;
}

function planFromRow(row: any): VerificationPlanRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id ?? "default",
    candidateId: row.candidate_id,
    candidateRevision: Number(row.candidate_revision),
    candidateHash: row.candidate_hash,
    requiredDomains: Array.isArray(row.required_domains) ? row.required_domains : [],
    checks: Array.isArray(row.checks) ? (row.checks as VerificationPlanRecord["checks"]) : [],
    sourceBindingsDigest: row.source_bindings_digest ?? "",
    status: row.status,
    rowVersion: Number(row.row_version ?? 1),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ""),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ""),
  };
}

function verdictRowFromRow(row: any): KnowledgeVerdictRowRecord {
  return {
    id: row.id,
    planId: row.plan_id,
    tenantId: row.tenant_id ?? "default",
    checkId: row.check_id,
    candidateId: row.candidate_id,
    candidateRevision: Number(row.candidate_revision),
    candidateHash: row.candidate_hash,
    principalId: row.principal_id,
    executionId: row.execution_id,
    kind: row.kind,
    verdict: row.verdict,
    reviewerRole: row.reviewer_role,
    note: row.note,
    domainId: row.domain_id ?? undefined,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    at: Number(row.at),
    rowVersion: Number(row.row_version ?? 1),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ""),
  };
}

/** PG 持久 VerificationPlan/verdict rows 仓库。 */
export function createPgKnowledgeVerificationRepo(pool: pg.Pool): KnowledgeVerificationRepo {
  const exec = (executor?: KnowledgeVerificationQueryable): KnowledgeVerificationQueryable => executor ?? pool;
  return {
    async getPlan(planId, tenantId, executor) {
      const res = await exec(executor).query(
        `SELECT * FROM knowledge_verification_plans WHERE id = $1 AND tenant_id = $2`,
        [planId, tenantId],
      );
      return res.rows.length === 0 ? undefined : planFromRow(res.rows[0]);
    },
    async listVerdictRows(planId, tenantId, executor) {
      const res = await exec(executor).query(
        `SELECT * FROM knowledge_verdict_rows WHERE plan_id = $1 AND tenant_id = $2 ORDER BY id ASC`,
        [planId, tenantId],
      );
      return (res.rows as any[]).map(verdictRowFromRow);
    },
    async insertVerdictRow(row, executor) {
      const db = exec(executor);
      const existing = await db.query(
        `SELECT * FROM knowledge_verdict_rows WHERE plan_id = $1 AND check_id = $2 AND principal_id = $3`,
        [row.planId, row.checkId, row.principalId],
      );
      if (existing.rows.length > 0) {
        const prev = verdictRowFromRow(existing.rows[0]);
        return sameVerdictPayload(prev, row)
          ? { ok: true, idempotent: true }
          : { ok: false, error: "verdict conflict: same plan/check/principal with different payload" };
      }
      const inserted = await db.query(
        `INSERT INTO knowledge_verdict_rows
           (plan_id, tenant_id, check_id, candidate_id, candidate_revision, candidate_hash,
            principal_id, execution_id, kind, verdict, reviewer_role, note, domain_id, evidence, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
         ON CONFLICT (plan_id, check_id, principal_id) DO NOTHING
         RETURNING id`,
        [
          row.planId,
          row.tenantId,
          row.checkId,
          row.candidateId,
          row.candidateRevision,
          row.candidateHash,
          row.principalId,
          row.executionId,
          row.kind,
          row.verdict,
          row.reviewerRole,
          row.note,
          row.domainId ?? null,
          JSON.stringify(row.evidence ?? []),
          row.at,
        ],
      );
      if (inserted.rows.length > 0) return { ok: true, idempotent: false };

      // 并发同 key：insert 被唯一索引挡住后，重读并比较 payload。
      const again = await db.query(
        `SELECT * FROM knowledge_verdict_rows WHERE plan_id = $1 AND check_id = $2 AND principal_id = $3`,
        [row.planId, row.checkId, row.principalId],
      );
      if (again.rows.length === 0) {
        return { ok: false, error: "verdict insert conflict: row not found after insert" };
      }
      const prev = verdictRowFromRow(again.rows[0]);
      return sameVerdictPayload(prev, row)
        ? { ok: true, idempotent: true }
        : { ok: false, error: "verdict conflict: same plan/check/principal with different payload" };
    },
    async setPlanStatus(planId, tenantId, status, executor) {
      await exec(executor).query(
        `UPDATE knowledge_verification_plans
         SET status = $3, row_version = row_version + 1, updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [planId, tenantId, status],
      );
    },
  };
}

/**
 * N29 Task 5：**生产** VerificationPlan 创建。
 *
 * 门禁（fail closed，先校验后写库）：
 *  - evidence 必须非空且每条都是合法 `IntakeEvidenceReference`；
 *  - 每条 evidence 的 policyDecisionDigest / sourceRevisionId 必须被 plan 覆盖；
 *  - `sourceBindingsDigest` 必须非空（不再允许 R3 旧空 digest 计划）；
 *  - checks 必须同时含 domain（domainId ∈ requiredDomains）与 adversarial，各自 quorum ≥ 1；
 *  - domain / adversarial 的 eligiblePrincipals 必须完全不相交（职责分离）。
 *
 * plan hash 由 `computeVerificationPlanHash()` 覆盖 content + domain + evidence +
 * policy decision digest + source revision；测试不得手写 SQL 作为生产路径。
 * 同 (tenant, candidate, candidateRevision) 重放：payload 全同 → idempotent；不同 → conflict。
 */
export interface VerificationPlanCreateInput {
  readonly planId: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly content: string;
  readonly requiredDomains: readonly string[];
  readonly evidence: readonly unknown[];
  readonly policyDecisionDigest: string;
  readonly sourceRevisionId: string;
  readonly checks: readonly VerificationCheckRecord[];
  readonly effect?: unknown;
}

export async function createVerificationPlan(
  input: VerificationPlanCreateInput,
  executor: KnowledgeVerificationQueryable,
): Promise<{ ok: true; plan: VerificationPlanRecord; idempotent: boolean } | { ok: false; error: string }> {
  if (!isNonEmptyString(input.planId) || !isNonEmptyString(input.tenantId) || !isNonEmptyString(input.candidateId)) {
    return { ok: false, error: "planId, tenantId and candidateId must be non-empty strings" };
  }
  if (!Number.isSafeInteger(input.candidateRevision) || input.candidateRevision < 1) {
    return { ok: false, error: "candidateRevision must be a positive safe integer" };
  }
  if (!isNonEmptyString(input.content)) {
    return { ok: false, error: "candidate content must be a non-empty string" };
  }
  const domains = [...new Set(input.requiredDomains.map((d) => d.trim()).filter((d) => d !== ""))].sort();
  if (domains.length === 0) {
    return { ok: false, error: "requiredDomains must contain at least one domain" };
  }
  if (!isNonEmptyString(input.sourceRevisionId)) {
    return { ok: false, error: "sourceRevisionId must be a non-empty string（unknown source revision is rejected）" };
  }
  if (!/^[0-9a-f]{64}$/.test(input.policyDecisionDigest)) {
    return { ok: false, error: "policyDecisionDigest must be a 64-char lowercase hex sha256" };
  }

  const refs = validateIntakeEvidenceReferences(input.evidence);
  if (!refs.ok) {
    return { ok: false, error: `verification plan evidence invalid: ${refs.error}` };
  }

  const sourceBindingsDigest = sourceBindingsDigestOf(input.evidence);
  if (sourceBindingsDigest.trim() === "") {
    return { ok: false, error: "verification plan requires a non-empty source binding digest" };
  }

  const domainChecks = input.checks.filter((c) => c.kind === "domain");
  const adversarialChecks = input.checks.filter((c) => c.kind === "adversarial");
  if (domainChecks.length === 0) {
    return { ok: false, error: "verification plan requires at least one domain check" };
  }
  if (adversarialChecks.length === 0) {
    return { ok: false, error: "verification plan requires at least one adversarial check" };
  }
  for (const check of input.checks) {
    if (!isNonEmptyString(check.checkId)) return { ok: false, error: "every check requires a non-empty checkId" };
    if (!Number.isSafeInteger(check.quorum) || check.quorum < 1) {
      return { ok: false, error: `check ${check.checkId} requires quorum >= 1` };
    }
    if (!Array.isArray(check.eligiblePrincipals) || check.eligiblePrincipals.length === 0) {
      return { ok: false, error: `check ${check.checkId} requires at least one eligible principal` };
    }
    if (check.kind === "domain" && !domains.includes(String(check.domainId ?? "").trim())) {
      return { ok: false, error: `domain check ${check.checkId} domainId must be one of requiredDomains` };
    }
    if (check.kind === "adversarial" && check.domainId !== undefined) {
      return { ok: false, error: `adversarial check ${check.checkId} must not carry domainId` };
    }
  }
  const domainPrincipals = new Set(domainChecks.flatMap((c) => c.eligiblePrincipals));
  for (const principal of adversarialChecks.flatMap((c) => c.eligiblePrincipals)) {
    if (domainPrincipals.has(principal)) {
      return { ok: false, error: `principal ${principal} cannot be eligible for both domain and adversarial checks` };
    }
  }

  let candidateHash: string;
  try {
    candidateHash = computeVerificationPlanHash({
      content: input.content,
      domains,
      evidence: input.evidence,
      policyDecisionDigest: input.policyDecisionDigest,
      sourceRevisionId: input.sourceRevisionId,
      effect: input.effect ?? null,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const checksJson = JSON.stringify(input.checks);
  // 无 target 的 DO NOTHING：同时吸收 PK(id) 与 uq(tenant,candidate,revision) 两种重放冲突。
  const inserted = await executor.query(
    `INSERT INTO knowledge_verification_plans
       (id, tenant_id, candidate_id, candidate_revision, candidate_hash, required_domains,
        checks, source_bindings_digest, status)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,'open')
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      input.planId,
      input.tenantId,
      input.candidateId,
      input.candidateRevision,
      candidateHash,
      JSON.stringify(domains),
      checksJson,
      sourceBindingsDigest,
    ],
  );
  if (inserted.rows.length > 0) {
    return { ok: true, plan: planFromRow(inserted.rows[0]), idempotent: false };
  }

  const existing = await executor.query(
    `SELECT * FROM knowledge_verification_plans
      WHERE tenant_id = $1 AND candidate_id = $2 AND candidate_revision = $3`,
    [input.tenantId, input.candidateId, input.candidateRevision],
  );
  if (existing.rows.length === 0) {
    return { ok: false, error: "verification plan insert conflict: row not found after insert" };
  }
  const prev = planFromRow(existing.rows[0]);
  const same = prev.id === input.planId
    && prev.candidateHash === candidateHash
    && prev.sourceBindingsDigest === sourceBindingsDigest
    && stableJsonOf(prev.requiredDomains) === stableJsonOf(domains)
    && stableJsonOf(prev.checks) === stableJsonOf(input.checks);
  if (!same) {
    return {
      ok: false,
      error: `verification plan conflict: ${input.tenantId}/${input.candidateId}@${input.candidateRevision} already exists with a different payload`,
    };
  }
  return { ok: true, plan: prev, idempotent: true };
}

async function refreshPlanStatus(
  repo: KnowledgeVerificationRepo,
  plan: VerificationPlanRecord,
  tenantId: string,
  producerRole: string | undefined,
): Promise<void> {
  const rows = await repo.listVerdictRows(plan.id, tenantId);
  const decision = evaluatePlanVerdicts(plan, rows, producerRole);
  if (decision.ok) {
    await repo.setPlanStatus(plan.id, tenantId, "satisfied");
    return;
  }
  if (rows.some((r) => r.verdict === "reject")) {
    await repo.setPlanStatus(plan.id, tenantId, "rejected");
  }
  // 未满足且无 reject：保持 open，等待更多 verdict。
}

async function enqueuePromotionIndexOutbox(
  client: pg.PoolClient,
  input: { entryId: string; planId: string; tenantId: string },
): Promise<void> {
  await enqueueSideEffectInTx(client, {
    key: `promotion-index:${input.tenantId}:${input.entryId}:${input.planId}`,
    tenantId: input.tenantId,
    kind: "promotion-index",
    payload: { entryId: input.entryId, planId: input.planId },
  });
}

/**
 * 记录候选 verdict（R3/P1-2）。auth 必填；只接受 planId + checkId + expectedCandidateRevision；
 * verdict 落 knowledge_verdict_rows（不 append entry.meta.verdicts）。
 */
export async function recordKnowledgeVerdict(
  store: Pick<PgMemoryStore, "get">,
  repo: KnowledgeVerificationRepo,
  planId: string,
  checkId: string,
  expectedCandidateRevision: number,
  verdict: KnowledgeVerdict,
  auth: KnowledgeServiceAuth,
  opts?: { tenantId?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isValidAuth(auth)) {
    return { ok: false, error: "auth context required: principalId and executionId must be non-empty" };
  }
  if (!isNonEmptyString(planId) || !isNonEmptyString(checkId)) {
    return { ok: false, error: "planId and checkId must be non-empty strings" };
  }
  if (typeof expectedCandidateRevision !== "number" || !Number.isFinite(expectedCandidateRevision)) {
    return { ok: false, error: "expectedCandidateRevision must be a finite number" };
  }

  const checked = validateKnowledgeVerdict(verdict);
  if (!checked.ok) return { ok: false, error: checked.error };

  const tenantId = opts?.tenantId ?? "default";
  const plan = await repo.getPlan(planId, tenantId);
  if (!plan) {
    return { ok: false, error: `verification plan ${planId} not found in tenant ${tenantId}` };
  }
  if (plan.status !== "open" && plan.status !== "satisfied") {
    return { ok: false, error: `verification plan ${planId} is ${plan.status}; only open/satisfied plans accept verdicts` };
  }
  if (expectedCandidateRevision !== plan.candidateRevision) {
    return { ok: false, error: `expectedCandidateRevision ${expectedCandidateRevision} does not match plan candidate_revision ${plan.candidateRevision}` };
  }

  const entry = await store.get(plan.candidateId, tenantOpts(opts));
  if (!entry) {
    return { ok: false, error: `candidate ${plan.candidateId} not found in tenant ${tenantId}` };
  }
  if (entry.status !== "draft") {
    return { ok: false, error: "only draft knowledge can be reviewed" };
  }

  const check = plan.checks.find((c) => c.checkId === checkId);
  if (!check) {
    return { ok: false, error: `check ${checkId} not in verification plan ${planId}` };
  }

  const v = checked.verdict;
  if (check.kind !== v.kind) {
    return { ok: false, error: `verdict kind ${v.kind} does not match check ${checkId} kind ${check.kind}` };
  }
  if (check.kind === "domain") {
    if (typeof check.domainId !== "string" || check.domainId.trim() === "") {
      return { ok: false, error: `domain check ${checkId} is missing domainId` };
    }
    if (v.domainId !== check.domainId) {
      return { ok: false, error: `domainId ${v.domainId ?? ""} does not match check ${checkId} domainId ${check.domainId}` };
    }
  } else if (v.domainId !== undefined) {
    return { ok: false, error: "adversarial verdict must not carry domainId" };
  }

  if (!check.eligiblePrincipals.includes(auth.principalId)) {
    return { ok: false, error: `principal ${auth.principalId} not eligible for check ${checkId}` };
  }

  const producerRole = (entry.meta?.["provenance"] as { producerRole?: unknown } | undefined)?.producerRole;
  if (typeof producerRole === "string" && auth.principalId === producerRole) {
    return { ok: false, error: "producer cannot review own knowledge" };
  }

  // separation：domain 与 adversarial verifier 的 server principal 必须不同。
  const existingRows = await repo.listVerdictRows(planId, tenantId);
  const passRows = existingRows.filter((r) => r.verdict === "pass");
  if (v.verdict === "pass") {
    if (check.kind === "domain" && passRows.some((r) => r.kind === "adversarial" && r.principalId === auth.principalId)) {
      return { ok: false, error: "domain verifier cannot also be adversarial verifier" };
    }
    if (check.kind === "adversarial" && passRows.some((r) => r.kind === "domain" && r.principalId === auth.principalId)) {
      return { ok: false, error: "adversarial verifier cannot also be domain verifier" };
    }
  }

  const row: Omit<KnowledgeVerdictRowRecord, "id" | "rowVersion" | "createdAt"> = {
    planId: plan.id,
    tenantId,
    checkId,
    candidateId: plan.candidateId,
    candidateRevision: plan.candidateRevision,
    candidateHash: plan.candidateHash,
    principalId: auth.principalId,
    executionId: auth.executionId,
    kind: v.kind,
    verdict: v.verdict,
    reviewerRole: v.reviewerRole,
    note: v.note,
    ...(v.domainId !== undefined ? { domainId: v.domainId } : {}),
    evidence: v.evidence ?? [],
    at: v.at,
  };

  const inserted = await repo.insertVerdictRow(row);
  if (!inserted.ok) return inserted;

  await refreshPlanStatus(repo, plan, tenantId, typeof producerRole === "string" ? producerRole : undefined);
  return { ok: true };
}

/**
 * N29 Task 5：晋升前的「current policy + source binding」复检端口。
 *
 * 在 `promoteOfficial()` 的既有锁事务内被调用（收到同一 `client`），用于回答
 * 「此刻这条 official 是否仍然被人类签名策略与不可变来源支持」：
 *  - SourceRevision 仍存在、仍属同 tenant/subscription、disposition 仍为 admitted；
 *  - evidence 的 quote/artifact/policy 摘要能被已落库 revision 逐字段重算；
 *  - 当前 policy 的 `authorizeUse()` 仍然 allow，且 policy decision digest 未变；
 *  - candidate→revision 依赖边未被标记 stale。
 *
 * fail closed：intake-bound candidate 缺少本端口时 **禁止** 晋升。
 */
export interface IntakeSourceBindingRecheckInput {
  readonly tenantId: string;
  readonly planId: string;
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly candidateHash: string;
  readonly evidence: readonly unknown[];
  readonly binding: CandidateIntakeBinding;
  readonly client: pg.PoolClient;
}

export interface IntakeSourceBindingRecheck {
  recheck(input: IntakeSourceBindingRecheckInput): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * 晋升 draft → official（R1 CAS + R3/P0-3 严格 revision/plan 绑定）。
 * 只接受 planId + expectedCandidateRevision；auth 必填。
 * 单事务内（PgMemoryStore.promoteOfficial）用同一 client 重读 plan/verdict rows，
 * canPromote 全绿后写 official + promotion meta + 索引 outbox。
 */
export async function promoteKnowledgeEntry(
  store: Pick<PgMemoryStore, "get" | "promoteOfficial">,
  repo: KnowledgeVerificationRepo,
  entryId: string,
  planId: string,
  expectedCandidateRevision: number,
  auth: KnowledgeServiceAuth,
  opts?: {
    tenantId?: string;
    promoterRole?: string;
    note?: string;
    /** N29：intake-bound candidate 必须提供；缺省 → fail closed 拒绝晋升。 */
    intakeBinding?: IntakeSourceBindingRecheck;
  },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!isValidAuth(auth)) {
    return { ok: false, error: "auth context required: principalId and executionId must be non-empty" };
  }
  if (!isNonEmptyString(entryId) || !isNonEmptyString(planId)) {
    return { ok: false, error: "entryId and planId must be non-empty strings" };
  }
  if (typeof expectedCandidateRevision !== "number" || !Number.isFinite(expectedCandidateRevision)) {
    return { ok: false, error: "expectedCandidateRevision must be a finite number" };
  }

  const tenantId = opts?.tenantId ?? "default";
  const promoterRole = opts?.promoterRole ?? "memory-keeper";

  const plan = await repo.getPlan(planId, tenantId);
  if (!plan) {
    return { ok: false, error: `verification plan ${planId} not found in tenant ${tenantId}` };
  }
  if (plan.candidateId !== entryId) {
    return { ok: false, error: `verification plan ${planId} candidate ${plan.candidateId} does not match entry ${entryId}` };
  }
  if (expectedCandidateRevision !== plan.candidateRevision) {
    return { ok: false, error: `expectedCandidateRevision ${expectedCandidateRevision} does not match plan candidate_revision ${plan.candidateRevision}` };
  }

  const promotionMeta = {
    promotedBy: promoterRole,
    ...(opts?.note !== undefined ? { note: opts.note } : {}),
    principalId: auth.principalId,
    promotedAt: Date.now(),
    planId,
    candidateRevision: plan.candidateRevision,
  };

  try {
    await store.promoteOfficial(entryId, tenantId, expectedCandidateRevision, promotionMeta, {
      createdBy: promoterRole,
      reason: "knowledge-promotion",
      evaluateAsync: async (entry, client) => {
        const lockedPlan = await repo.getPlan(planId, tenantId, client);
        if (!lockedPlan) {
          return { ok: false, reason: `verification plan ${planId} not found in tenant ${tenantId}` };
        }
        const rows = await repo.listVerdictRows(planId, tenantId, client);
        const producerRole = (entry.meta?.["provenance"] as { producerRole?: unknown } | undefined)?.producerRole;
        if (typeof producerRole === "string" && auth.principalId === producerRole) {
          return { ok: false, reason: "promoter cannot be producer" };
        }
        const verifierPrincipals = new Set(rows.filter((r) => r.verdict === "pass").map((r) => r.principalId));
        if (verifierPrincipals.has(auth.principalId)) {
          return { ok: false, reason: "promoter cannot also be a verifier" };
        }
        const gate = canPromote(entry, lockedPlan, rows);
        if (!gate.ok) return gate;

        // N29 Task 5：外部信源 candidate 必须在锁内重新校验 current policy + source binding。
        if (isIntakeBoundCandidate(entry)) {
          const binding = candidateIntakeBindingOf(entry);
          if (!binding) {
            return { ok: false, reason: "N29 intake candidate requires a well-formed meta.intake source binding" };
          }
          if (binding.producerPrincipalId === auth.principalId) {
            return { ok: false, reason: "promoter cannot be producer" };
          }
          if (!opts?.intakeBinding) {
            return {
              ok: false,
              reason:
                "N29 intake candidate requires a current policy and source binding recheck before writing official"
                + "（promoteKnowledgeEntry opts.intakeBinding is missing → fail closed）",
            };
          }
          const rechecked = await opts.intakeBinding.recheck({
            tenantId,
            planId,
            candidateId: entryId,
            candidateRevision: lockedPlan.candidateRevision,
            candidateHash: lockedPlan.candidateHash,
            evidence: Array.isArray(entry.meta?.["evidence"]) ? (entry.meta["evidence"] as unknown[]) : [],
            binding,
            client,
          });
          if (!rechecked.ok) return rechecked;
        }
        return { ok: true };
      },
      enqueueOutbox: async (client) => {
        await enqueuePromotionIndexOutbox(client, { entryId, planId, tenantId });
      },
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
 * R3 说明：拒绝仍走既有 meta.verdicts 历史显示通道；晋升判定已不再读取该数组。
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
