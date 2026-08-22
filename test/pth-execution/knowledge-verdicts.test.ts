import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { Pool } from "pg";
import {
  buildKnowledgeProvenance,
  DEFAULT_TENANT_ID,
  PgMemoryStore,
} from "@away_from/pth-memory";
import { applySchema } from "@away_from/pth-kernel-storage";
import {
  canPromote,
  candidateHashForEntry,
  candidateIntakeBindingOf,
  checkIntakeCandidateBinding,
  computeCandidateHash,
  isIntakeBoundCandidate,
  sourceBindingsDigestOf,
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

describe("knowledge verdicts pure（R5 sourceBindingsDigest fill-in）", () => {
  const content = "The Earth orbits the Sun.";
  const evidence = [
    { sourceId: "pilot-source:pl-jls", locator: "JLS SE23 §4.12.2", sourceVersion: "Java SE 23", artifactHash: "a".repeat(64) },
    { sourceId: "pilot-source:pl-rust-reference", locator: "Rust Reference: type system" },
  ];

  it("sourceBindingsDigestOf is sha256 hex and covers structured evidence array", () => {
    const digest = sourceBindingsDigestOf(evidence);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(sourceBindingsDigestOf([evidence[0]]));
  });

  it("candidateHashForEntry covers structured meta.evidence objects", () => {
    const base = {
      id: "cand-1",
      tenantId: TENANT,
      kind: "domain-fact",
      anchors: ["science"],
      content,
      status: "draft" as const,
      meta: {
        version: 1,
        provenance: buildKnowledgeProvenance({
          content,
          sourceTaskId: "task-1",
          producerRole: "developer",
          producerModel: "deepseek-v4-flash",
          sourceRefs: ["task:task-1"],
        }),
        evidence,
      },
    };
    const withEvidence = candidateHashForEntry(base, ["mathematics"]);
    const withoutEvidence = candidateHashForEntry({ ...base, meta: { ...base.meta, evidence: [] } }, ["mathematics"]);
    expect(withEvidence).not.toBe(withoutEvidence);
  });

  it("canPromote rejects when sourceBindingsDigest does not match current meta.evidence", () => {
    const entry = {
      id: "cand-1",
      tenantId: TENANT,
      kind: "domain-fact",
      anchors: ["science"],
      content,
      status: "draft" as const,
      meta: {
        version: 1,
        provenance: buildKnowledgeProvenance({
          content,
          sourceTaskId: "task-1",
          producerRole: "developer",
          producerModel: "deepseek-v4-flash",
          sourceRefs: ["task:task-1"],
        }),
        evidence,
      },
    };
    const plan: VerificationPlanRecord = {
      id: "plan-1",
      tenantId: TENANT,
      candidateId: "cand-1",
      candidateRevision: 1,
      candidateHash: computeCandidateHash({ content, domains: ["mathematics"], evidence, effect: null }),
      requiredDomains: ["mathematics"],
      checks: [{
        checkId: "domain-1",
        kind: "domain",
        domainId: "mathematics",
        quorum: 1,
        eligiblePrincipals: ["tenant:tenant-a:platform-admin"],
        separationFrom: ["producer"],
      }],
      sourceBindingsDigest: sourceBindingsDigestOf([{ sourceId: "pilot-source:other", locator: "other" }]),
      status: "satisfied",
      rowVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const rows: KnowledgeVerdictRowRecord[] = [{
      id: 1,
      planId: "plan-1",
      tenantId: TENANT,
      checkId: "domain-1",
      candidateId: "cand-1",
      candidateRevision: 1,
      candidateHash: plan.candidateHash,
      principalId: "tenant:tenant-a:platform-admin",
      executionId: "task-1",
      kind: "domain",
      verdict: "pass",
      reviewerRole: "domain:expert",
      note: "verified",
      domainId: "mathematics",
      evidence: [],
      at: 1,
      rowVersion: 1,
      createdAt: new Date().toISOString(),
    }];

    const decision = canPromote(entry, plan, rows);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("sourceBindingsDigest mismatch");
  });
});

const TENANT = DEFAULT_TENANT_ID;

suite("knowledge verdicts（R3/P0-3，real PostgreSQL）", () => {
  let container: StartedPostgreSqlContainer;
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
  /**
   * N29 再验收 P0-5（feedback §3 P0-5 / §8 条件 6）：`canPromote()` 的 legacy 兼容路径
   * （空 sourceBindingsDigest + 空 evidence）已删除——内部 candidate 也必须显式声明来源绑定，
   * 因此本套件的 candidate/plan 固定携带一组内部 evidence 引用。
   */
  const internalEvidence = [{ sourceId: "task:task-1", locator: "task-output#1" }];
  const boundCandidateHash = computeCandidateHash({
    content,
    domains: ["mathematics"],
    evidence: internalEvidence,
    effect: null,
  });

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
        evidence: internalEvidence,
      },
    } as any);
  }

  async function seedPlan(overrides: Partial<VerificationPlanRecord> = {}): Promise<VerificationPlanRecord> {
    const plan: VerificationPlanRecord = {
      id: "plan-1",
      tenantId: TENANT,
      candidateId: "cand-1",
      candidateRevision: 1,
      candidateHash: boundCandidateHash,
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
      sourceBindingsDigest: sourceBindingsDigestOf(internalEvidence),
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
      candidateHash: boundCandidateHash,
      kind: "domain",
      verdict: "pass",
      reviewerRole: "domain:expert",
      note: "verified",
      domainId: undefined,
      evidence: [],
      at: 1,
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

  it("canPromote requires domain/adversarial execution separation（P1-2：同 executionId 拒绝）", async () => {
    await seedDraft("cand-exec-sep");
    const satisfiedPlan = await seedPlan({
      id: "plan-exec-sep",
      candidateId: "cand-exec-sep",
      status: "satisfied",
      checks: [
        { checkId: "domain-1", kind: "domain", domainId: "mathematics", quorum: 1, eligiblePrincipals: ["tenant:tenant-a:domain-expert-2"], separationFrom: ["producer"] },
        { checkId: "adv-1", kind: "adversarial", quorum: 1, eligiblePrincipals: ["worker:controller:adversarial"], separationFrom: ["producer"] },
      ],
    });
    const entry = await store.get("cand-exec-sep", { tenantId: TENANT });

    // 不同 principal，但同一 executionId ——同一执行实例不得代表两个 principal 双重核验。
    await insertVerdictRow({
      planId: satisfiedPlan.id, checkId: "domain-1",
      principalId: "tenant:tenant-a:domain-expert-2", executionId: "task-shared-exec",
      candidateId: "cand-exec-sep", kind: "domain", domainId: "mathematics", verdict: "pass",
    });
    await insertVerdictRow({
      planId: satisfiedPlan.id, checkId: "adv-1",
      principalId: "worker:controller:adversarial", executionId: "task-shared-exec",
      candidateId: "cand-exec-sep", kind: "adversarial", verdict: "pass",
    });
    const rows = await repo.listVerdictRows(satisfiedPlan.id, TENANT);
    const decision = canPromote(entry!, satisfiedPlan, rows);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("executions must differ");
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

describe("N29 candidate source binding（verdicts 纯判据）", () => {
  const CONTENT = "The sum of the interior angles of a triangle equals 180 degrees.";
  const REV = "rev-v-1";
  const SUB = "sub-v-1";
  const PRODUCER = "worker:extractor:producer";
  const DOMAIN_REVIEWER = "worker:domain:mathematics-reviewer";
  const ADVERSARIAL_REVIEWER = "worker:controller:adversarial";

  const ref = {
    sourceSubscriptionId: SUB,
    sourceRevisionId: REV,
    representation: "normalized-text" as const,
    locator: { start: 0, end: CONTENT.length },
    quoteHash: "a".repeat(64),
    artifactHash: "b".repeat(64),
    policyDecisionDigest: "c".repeat(64),
  };
  const binding = {
    sourceSubscriptionId: SUB,
    sourceRevisionId: REV,
    representation: "normalized-text" as const,
    artifactHash: ref.artifactHash,
    policyDecisionDigest: ref.policyDecisionDigest,
    tenantId: "tenant-a",
    space: "space-a",
    domainId: "mathematics",
    producerPrincipalId: PRODUCER,
  };

  function entryOf(evidence: unknown[], intake: unknown = binding) {
    return {
      id: "cand-v",
      tenantId: "tenant-a",
      kind: "domain-fact",
      anchors: ["mathematics"],
      content: CONTENT,
      status: "draft" as const,
      meta: { version: 1, domains: ["mathematics"], evidence, intake },
    };
  }

  function planOf(evidence: unknown[], over: Partial<VerificationPlanRecord> = {}): VerificationPlanRecord {
    return {
      id: "plan-v",
      tenantId: "tenant-a",
      candidateId: "cand-v",
      candidateRevision: 1,
      candidateHash: computeCandidateHash({ content: CONTENT, domains: ["mathematics"], evidence, effect: null }),
      requiredDomains: ["mathematics"],
      checks: [
        { checkId: "domain:mathematics", kind: "domain", domainId: "mathematics", quorum: 1, eligiblePrincipals: [DOMAIN_REVIEWER], separationFrom: [PRODUCER] },
        { checkId: "adversarial", kind: "adversarial", quorum: 1, eligiblePrincipals: [ADVERSARIAL_REVIEWER], separationFrom: [PRODUCER] },
      ],
      sourceBindingsDigest: sourceBindingsDigestOf(evidence),
      status: "satisfied",
      rowVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...over,
    };
  }

  it("isIntakeBoundCandidate 只对携带 intake 绑定/精确 evidence 的 candidate 为真", () => {
    expect(isIntakeBoundCandidate(entryOf([ref]))).toBe(true);
    expect(isIntakeBoundCandidate(entryOf([ref], undefined))).toBe(true);
    expect(isIntakeBoundCandidate({ ...entryOf([{ sourceId: "s", locator: "l" }], undefined), meta: { version: 1, evidence: [{ sourceId: "s", locator: "l" }] } })).toBe(false);
  });

  it("candidateIntakeBindingOf 拒绝残缺 meta.intake", () => {
    expect(candidateIntakeBindingOf(entryOf([ref]))).toMatchObject({ sourceRevisionId: REV });
    expect(candidateIntakeBindingOf(entryOf([ref], { sourceRevisionId: REV }))).toBeUndefined();
    expect(candidateIntakeBindingOf(entryOf([ref], { ...binding, representation: "raw" }))).toBeUndefined();
    expect(candidateIntakeBindingOf(entryOf([ref], "nope"))).toBeUndefined();
  });

  it("N29 candidate 不得使用空 sourceBindingsDigest", () => {
    const bound = checkIntakeCandidateBinding(entryOf([ref]), planOf([ref], { sourceBindingsDigest: "" }));
    expect(bound).toMatchObject({ ok: false, reason: expect.stringContaining("source binding") });
  });

  it("N29 candidate 拒绝空 evidence", () => {
    const bound = checkIntakeCandidateBinding(entryOf([]), planOf([], { sourceBindingsDigest: sourceBindingsDigestOf([]) }));
    expect(bound).toMatchObject({ ok: false, reason: expect.stringContaining("evidence") });
  });

  it("N29 candidate 必须同时具备 domain 与 adversarial check，且 producer 不得自审", () => {
    const plan = planOf([ref]);
    expect(checkIntakeCandidateBinding(entryOf([ref]), { ...plan, checks: [plan.checks[0]] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("adversarial") });
    expect(checkIntakeCandidateBinding(entryOf([ref]), { ...plan, checks: [plan.checks[1]] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("domain check") });
    expect(checkIntakeCandidateBinding(entryOf([ref]), {
      ...plan,
      checks: plan.checks.map((c) => ({ ...c, eligiblePrincipals: [...c.eligiblePrincipals, PRODUCER] })),
    })).toMatchObject({ ok: false, reason: expect.stringContaining("producer principal") });
  });

  it("完整绑定通过（domain + adversarial + 非空 digest + 精确 evidence）", () => {
    const bound = checkIntakeCandidateBinding(entryOf([ref]), planOf([ref]));
    expect(bound.ok).toBe(true);
  });
});
