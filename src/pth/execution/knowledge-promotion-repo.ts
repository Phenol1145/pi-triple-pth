import type pg from "pg";
import type {
  KnowledgeVerdictRowRecord,
  VerificationPlanRecord,
  VerificationPlanStatus,
} from "./knowledge-verdicts.js";

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

export function planFromRow(row: any): VerificationPlanRecord {
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
