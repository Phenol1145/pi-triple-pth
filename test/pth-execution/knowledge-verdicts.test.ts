import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { Pool } from "pg";
import {
  buildKnowledgeProvenance,
  DEFAULT_TENANT_ID,
  PgMemoryStore,
} from "@away_from/pth-memory";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import {
  canPromote,
  candidateHashForEntry,
  computeCandidateHash,
  type KnowledgeVerdictRowRecord,
  type VerificationPlanRecord,
} from "../../src/pth/execution/knowledge-verdicts.js";
import {
  createPgKnowledgeVerificationRepo,
  recordKnowledgeVerdict,
  type KnowledgeVerificationRepo,
} from "../../src/pth/execution/knowledge-promotion.js";

async function hasDocker(): Promise<boolean> {
  if (process.env.PTH_TEST_NO_DOCKER === "1") return false;
  try {
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = await hasDocker();
const suite = dockerAvailable ? describe : describe.skip;

const TENANT = DEFAULT_TENANT_ID;

suite("knowledge verdicts（R3/P0-3，real PostgreSQL）", () => {
  let container: PostgreSqlContainer;
  let pool: Pool;
  let store: PgMemoryStore;
  let repo: KnowledgeVerificationRepo;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    store = new PgMemoryStore(pool);
    repo = createPgKnowledgeVerificationRepo(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  const content = "The Earth orbits the Sun.";

  async function seedDraft(id = "cand-1"): Promise<void> {
    await store.write({
      id,
      kind: "domain-fact",
      anchors: ["science"],
      content,
      status: "draft",
      tenantId: TENANT,
      meta: {
        provenance: buildKnowledgeProvenance({
          content,
          sourceTaskId: "task-1",
          producerRole: "developer",
          producerModel: "deepseek-v4-flash",
          sourceRefs: ["task:task-1"],
        }),
      },
    } as any);
  }

  async function seedPlan(overrides: Partial<VerificationPlanRecord> = {}): Promise<VerificationPlanRecord> {
    const plan: VerificationPlanRecord = {
      id: "plan-1",
      tenantId: TENANT,
      candidateId: "cand-1",
      candidateRevision: 1,
      candidateHash: computeCandidateHash({ content, domains: ["mathematics"], evidence: [], effect: null }),
      requiredDomains: ["mathematics"],
      checks: [
        {
          checkId: "domain-1",
          kind: "domain",
          domainId: "mathematics",
          quorum: 1,
          eligiblePrincipals: ["tenant:tenant-a:platform-admin", "tenant:tenant-a:domain-expert-2"],
          separationFrom: ["producer", "other-verifier"],
        },
        {
          checkId: "adv-1",
          kind: "adversarial",
          quorum: 1,
          eligiblePrincipals: ["worker:controller:adversarial"],
          separationFrom: ["producer", "other-verifier"],
        },
      ],
      sourceBindingsDigest: "",
      status: "satisfied",
      rowVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
    await pool.query(
      `INSERT INTO knowledge_verification_plans
         (id, tenant_id, candidate_id, candidate_revision, candidate_hash, required_domains, checks, source_bindings_digest, status, row_version)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         candidate_id = EXCLUDED.candidate_id,
         candidate_revision = EXCLUDED.candidate_revision,
         candidate_hash = EXCLUDED.candidate_hash,
         required_domains = EXCLUDED.required_domains,
         checks = EXCLUDED.checks,
         source_bindings_digest = EXCLUDED.source_bindings_digest,
         status = EXCLUDED.status,
         row_version = EXCLUDED.row_version,
         updated_at = now()`,
      [
        plan.id,
        plan.tenantId,
        plan.candidateId,
        plan.candidateRevision,
        plan.candidateHash,
        JSON.stringify(plan.requiredDomains),
        JSON.stringify(plan.checks),
        plan.sourceBindingsDigest,
        plan.status,
        plan.rowVersion,
      ],
    );
    return (await repo.getPlan(plan.id, TENANT))!;
  }

  async function insertVerdictRow(row: Partial<KnowledgeVerdictRowRecord> & {
    planId: string; checkId: string; principalId: string; executionId: string;
  }): Promise<void> {
    const full: Omit<KnowledgeVerdictRowRecord, "id" | "rowVersion" | "createdAt"> = {
      tenantId: TENANT,
      candidateId: "cand-1",
      candidateRevision: 1,
      candidateHash: computeCandidateHash({ content, domains: ["mathematics"], evidence: [], effect: null }),
      kind: "domain",
      verdict: "pass",
      reviewerRole: "domain:expert",
      note: "verified",
      domainId: undefined,
      evidence: [],
      at: 1,
      planId: row.planId,
      checkId: row.checkId,
      principalId: row.principalId,
      executionId: row.executionId,
      ...row,
    } as Omit<KnowledgeVerdictRowRecord, "id" | "rowVersion" | "createdAt">;
    await pool.query(
      `INSERT INTO knowledge_verdict_rows
         (plan_id, tenant_id, check_id, candidate_id, candidate_revision, candidate_hash,
          principal_id, execution_id, kind, verdict, reviewer_role, note, domain_id, evidence, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
      [
        full.planId, full.tenantId, full.checkId, full.candidateId, full.candidateRevision, full.candidateHash,
        full.principalId, full.executionId, full.kind, full.verdict, full.reviewerRole, full.note,
        full.domainId ?? null, JSON.stringify(full.evidence), full.at,
      ],
    );
  }

  it("canPromote rejects verdict with stale candidateRevision even when lower than current version", async () => {
    await seedDraft("cand-stale");
    const plan = await seedPlan({ id: "plan-stale", candidateId: "cand-stale", candidateRevision: 3 });
    await pool.query(`UPDATE memory_entries SET version = 3 WHERE id = 'cand-stale' AND tenant_id = $1`, [TENANT]);
    const entry = await store.get("cand-stale", { tenantId: TENANT });
    expect(entry?.meta?.version).toBe(3);

    await insertVerdictRow({
      planId: plan.id,
      checkId: "domain-1",
      principalId: "tenant:tenant-a:platform-admin",
      executionId: "task-1",
      candidateId: "cand-stale",
      candidateRevision: 2, // stale：低于当前 version 3
      candidateHash: plan.candidateHash,
      kind: "domain",
      domainId: "mathematics",
      verdict: "pass",
    });
    const rows = await repo.listVerdictRows(plan.id, TENANT);
    const decision = canPromote(entry!, plan, rows);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("candidateRevision");
  });

  it("canPromote rejects verdict whose candidateHash differs from plan", async () => {
    await seedDraft("cand-hash");
    const plan = await seedPlan({ id: "plan-hash", candidateId: "cand-hash" });
    await insertVerdictRow({
      planId: plan.id,
      checkId: "domain-1",
      principalId: "tenant:tenant-a:platform-admin",
      executionId: "task-1",
      candidateId: "cand-hash",
      candidateHash: "bad-hash",
      kind: "domain",
      domainId: "mathematics",
      verdict: "pass",
    });
    const entry = await store.get("cand-hash", { tenantId: TENANT });
    const rows = await repo.listVerdictRows(plan.id, TENANT);
    const decision = canPromote(entry!, plan, rows);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("candidateHash");
  });

  it("canPromote requires plan.status=satisfied and per-check quorum", async () => {
    await seedDraft("cand-quorum");
    const openPlan = await seedPlan({
      id: "plan-quorum",
      candidateId: "cand-quorum",
      status: "open",
      checks: [
        { checkId: "domain-1", kind: "domain", domainId: "mathematics", quorum: 2, eligiblePrincipals: ["tenant:tenant-a:platform-admin", "tenant:tenant-a:domain-expert-2"], separationFrom: ["producer"] },
        { checkId: "adv-1", kind: "adversarial", quorum: 1, eligiblePrincipals: ["worker:controller:adversarial"], separationFrom: ["producer"] },
      ],
    });
    const entry = await store.get("cand-quorum", { tenantId: TENANT });

    const withDomainPass = await (async () => {
      const p = await repo.getPlan("plan-quorum", TENANT);
      await insertVerdictRow({
        planId: p!.id,
        checkId: "domain-1",
        principalId: "tenant:tenant-a:platform-admin",
        executionId: "task-1",
        candidateId: "cand-quorum",
        kind: "domain",
        domainId: "mathematics",
        verdict: "pass",
      });
      return repo.listVerdictRows(p!.id, TENANT);
    })();

    const openDecision = canPromote(entry!, openPlan, withDomainPass);
    expect(openDecision.ok).toBe(false);
    if (!openDecision.ok) expect(openDecision.reason).toContain("plan.status");

    const satisfiedPlan = await seedPlan({
      id: "plan-quorum",
      candidateId: "cand-quorum",
      status: "satisfied",
      checks: [
        { checkId: "domain-1", kind: "domain", domainId: "mathematics", quorum: 2, eligiblePrincipals: ["tenant:tenant-a:platform-admin", "tenant:tenant-a:domain-expert-2"], separationFrom: ["producer"] },
        { checkId: "adv-1", kind: "adversarial", quorum: 1, eligiblePrincipals: ["worker:controller:adversarial"], separationFrom: ["producer"] },
      ],
    });
    const quorumShort = canPromote(entry!, satisfiedPlan, withDomainPass);
    expect(quorumShort.ok).toBe(false);
    if (!quorumShort.ok) expect(quorumShort.reason).toContain("quorum");

    await insertVerdictRow({
      planId: satisfiedPlan.id,
      checkId: "domain-1",
      principalId: "tenant:tenant-a:domain-expert-2",
      executionId: "task-2",
      candidateId: "cand-quorum",
      kind: "domain",
      domainId: "mathematics",
      verdict: "pass",
    });
    await insertVerdictRow({
      planId: satisfiedPlan.id,
      checkId: "adv-1",
      principalId: "worker:controller:adversarial",
      executionId: "task-3",
      candidateId: "cand-quorum",
      kind: "adversarial",
      verdict: "pass",
    });
    const rows = await repo.listVerdictRows(satisfiedPlan.id, TENANT);
    expect(canPromote(entry!, satisfiedPlan, rows)).toEqual({ ok: true });
  });

  it("verdict rows have independent row_version; append verdict does not bump candidate meta.version", async () => {
    await seedDraft("cand-rowversion");
    const plan = await seedPlan({ id: "plan-rowversion", candidateId: "cand-rowversion", status: "open" });

    const authDomain = { principalId: "tenant:tenant-a:platform-admin", executionId: "task-d", roleId: "platform-admin" };
    const authAdv = { principalId: "worker:controller:adversarial", executionId: "task-a", roleId: "controller:adversarial" };

    expect((await recordKnowledgeVerdict(store, repo, plan.id, "domain-1", 1, {
      kind: "domain", verdict: "pass", reviewerRole: "domain:expert",
      note: "domain evidence verified", at: 1, domainId: "mathematics",
    }, authDomain, { tenantId: TENANT })).ok).toBe(true);

    expect((await recordKnowledgeVerdict(store, repo, plan.id, "adv-1", 1, {
      kind: "adversarial", verdict: "pass", reviewerRole: "controller:adversarial",
      note: "no shortcut", at: 2,
    }, authAdv, { tenantId: TENANT })).ok).toBe(true);

    const entry = await store.get("cand-rowversion", { tenantId: TENANT });
    expect(entry?.meta?.version).toBe(1); // verdict append 不再递增 candidate content revision
    const rows = await repo.listVerdictRows(plan.id, TENANT);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(typeof row.rowVersion).toBe("number");
    }
    // candidate hash 与 entry 当前内容/domains/evidence 一致（plan 快照可复算）
    expect(candidateHashForEntry(entry!, plan.requiredDomains)).toBe(plan.candidateHash);
    // verdict 落行后 plan 应被 service 刷新为 satisfied（独立于 entry.meta）
    const refreshed = await repo.getPlan(plan.id, TENANT);
    expect(refreshed?.status).toBe("satisfied");
  });
});
