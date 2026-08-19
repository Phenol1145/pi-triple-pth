import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { Pool } from "pg";
import {
  buildKnowledgeProvenance,
  DEFAULT_TENANT_ID,
  PgMemoryStore,
  type MemoryEntry,
  type PgMemoryStorePromoteOfficialOptions,
  type PgMemoryStorePromotionMeta,
} from "@away_from/pth-memory";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import {
  canPromote,
  computeCandidateHash,
  computeVerificationPlanHash,
  isIntakeBoundCandidate,
  sourceBindingsDigestOf,
  validateKnowledgeVerdict,
  type KnowledgeVerdict,
  type KnowledgeVerdictRowRecord,
  type VerificationPlanRecord,
} from "../../src/pth/execution/knowledge-verdicts.js";
import {
  createPgKnowledgeVerificationRepo,
  createVerificationPlan,
  promoteKnowledgeEntry,
  recordKnowledgeVerdict,
  rejectKnowledgeEntry,
  type KnowledgeServiceAuth,
  type KnowledgeVerificationRepo,
} from "../../src/pth/execution/knowledge-promotion.js";
import { createInMemoryPromoteOfficial } from "../helpers";

const TENANT = DEFAULT_TENANT_ID;
const content = "The Earth orbits the Sun.";

/**
 * N29 再验收 P0-5（feedback §3 P0-5 / §8 条件 6）：`canPromote()` 不再保留"空
 * sourceBindingsDigest + 空 evidence"的 legacy 兼容路径。内部推理知识（非外部信源 candidate）
 * 也必须显式声明来源绑定，因此本套件的 legacy candidate/plan 固定携带一组内部 evidence 引用。
 */
const LEGACY_EVIDENCE = [{ sourceId: "task:task-1", locator: "task-output#1" }];
const LEGACY_CANDIDATE_HASH = computeCandidateHash({
  content,
  domains: ["mathematics"],
  evidence: LEGACY_EVIDENCE,
  effect: null,
});

function makeDraft(id = "cand-1", overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    tenantId: TENANT,
    kind: "task-insight",
    anchors: ["science"],
    content,
    status: "draft",
    meta: {
      version: 1,
      provenance: buildKnowledgeProvenance({
        content,
        sourceTaskId: "task-1",
        producerRole: "developer",
        producerModel: "deepseek-v4-flash",
        sourceRefs: ["task:task-1"],
      }),
      evidence: LEGACY_EVIDENCE,
      verdicts: [] as KnowledgeVerdict[],
    },
    ...overrides,
  };
}

function domainPass(overrides: Partial<KnowledgeVerdict> = {}): KnowledgeVerdict {
  return {
    kind: "domain",
    verdict: "pass",
    reviewerRole: "domain:expert",
    note: "domain evidence verified",
    at: 1,
    domainId: "mathematics",
    ...overrides,
  };
}

function adversarialPass(overrides: Partial<KnowledgeVerdict> = {}): KnowledgeVerdict {
  return {
    kind: "adversarial",
    verdict: "pass",
    reviewerRole: "controller:adversarial",
    note: "no shortcut / pitfall covered",
    at: 2,
    ...overrides,
  };
}

function makePlan(overrides: Partial<VerificationPlanRecord> = {}): VerificationPlanRecord {
  return {
    id: "plan-1",
    tenantId: TENANT,
    candidateId: "cand-1",
    candidateRevision: 1,
    candidateHash: LEGACY_CANDIDATE_HASH,
    requiredDomains: ["mathematics"],
    checks: [
      {
        checkId: "domain-1",
        kind: "domain",
        domainId: "mathematics",
        quorum: 1,
        eligiblePrincipals: ["tenant:tenant-a:platform-admin", "worker:controller:adversarial"],
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
    sourceBindingsDigest: sourceBindingsDigestOf(LEGACY_EVIDENCE),
    status: "satisfied",
    rowVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeVerificationRepo() {
  const plans = new Map<string, VerificationPlanRecord>();
  const rows = new Map<string, KnowledgeVerdictRowRecord>();
  let nextId = 1;
  const repo: KnowledgeVerificationRepo = {
    async getPlan(planId, tenantId) {
      const p = plans.get(planId);
      if (!p || p.tenantId !== tenantId) return undefined;
      return structuredClone(p);
    },
    async listVerdictRows(planId, tenantId) {
      return [...rows.values()]
        .filter((r) => r.planId === planId && r.tenantId === tenantId)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map((r) => structuredClone(r));
    },
    async insertVerdictRow(row) {
      const key = `${row.planId}::${row.checkId}::${row.principalId}`;
      const existing = rows.get(key);
      if (existing) {
        const same = existing.candidateId === row.candidateId
          && existing.candidateRevision === row.candidateRevision
          && existing.candidateHash === row.candidateHash
          && existing.executionId === row.executionId
          && existing.kind === row.kind
          && existing.verdict === row.verdict
          && existing.reviewerRole === row.reviewerRole
          && existing.note === row.note
          && (existing.domainId ?? null) === (row.domainId ?? null)
          && JSON.stringify(existing.evidence) === JSON.stringify(row.evidence)
          && existing.at === row.at;
        return same
          ? { ok: true, idempotent: true }
          : { ok: false, error: "verdict conflict: same plan/check/principal with different payload" };
      }
      const full: KnowledgeVerdictRowRecord = {
        ...row,
        id: nextId++,
        rowVersion: 1,
        createdAt: new Date().toISOString(),
      };
      rows.set(key, full);
      return { ok: true, idempotent: false };
    },
    async setPlanStatus(planId, tenantId, status) {
      const p = plans.get(planId);
      if (p && p.tenantId === tenantId) {
        p.status = status;
        p.rowVersion += 1;
        p.updatedAt = new Date().toISOString();
      }
    },
  };
  return { repo, plans, rows };
}

function makeStore(initial: MemoryEntry[] = []) {
  const rows = new Map<string, MemoryEntry>();
  for (const e of initial) rows.set(e.id, structuredClone(e));
  const sharedPromote = createInMemoryPromoteOfficial(rows);
  return {
    rows,
    async get(id: string, opts?: { tenantId?: string }) {
      const e = rows.get(id);
      if (!e) return undefined;
      if (opts?.tenantId && e.tenantId && e.tenantId !== opts.tenantId) return undefined;
      return structuredClone(e);
    },
    async update(id: string, patch: Partial<MemoryEntry> & { meta?: Record<string, unknown> }, opts?: { tenantId?: string }) {
      const e = rows.get(id);
      if (!e) throw new Error(`entry not found in tenant ${opts?.tenantId ?? "default"}`);
      if (opts?.tenantId && e.tenantId && e.tenantId !== opts.tenantId) throw new Error(`entry not found in tenant ${opts.tenantId}`);
      if (patch.content !== undefined) e.content = patch.content;
      if (patch.status !== undefined) e.status = patch.status;
      if (patch.meta !== undefined) e.meta = { ...(e.meta ?? {}), ...patch.meta };
    },
    async promoteOfficial(
      id: string,
      tenantId: string,
      expectedRevision: number,
      promotionMeta: PgMemoryStorePromotionMeta,
      opts: PgMemoryStorePromoteOfficialOptions = {},
    ) {
      return sharedPromote(id, tenantId, expectedRevision, promotionMeta, opts);
    },
  };
}

function makeAuth(overrides: Partial<KnowledgeServiceAuth> = {}): KnowledgeServiceAuth {
  return {
    principalId: "tenant:tenant-a:platform-admin",
    executionId: "task-admin",
    roleId: "platform-admin",
    ...overrides,
  };
}

describe("validateKnowledgeVerdict（N22 1）", () => {
  it("合法 verdict 通过并返回规整对象", () => {
    const v = domainPass();
    const r = validateKnowledgeVerdict(v);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict).toEqual(v);
  });

  it("kind/verdict/reviewerRole/note/at 非法 → 拒绝", () => {
    expect(validateKnowledgeVerdict({ ...domainPass(), kind: "bad" }).ok).toBe(false);
    expect(validateKnowledgeVerdict({ ...domainPass(), verdict: "maybe" }).ok).toBe(false);
    expect(validateKnowledgeVerdict({ ...domainPass(), reviewerRole: "" }).ok).toBe(false);
    expect(validateKnowledgeVerdict({ ...domainPass(), note: "  " }).ok).toBe(false);
    expect(validateKnowledgeVerdict({ ...domainPass(), at: Number.NaN }).ok).toBe(false);
    expect(validateKnowledgeVerdict(null).ok).toBe(false);
    expect(validateKnowledgeVerdict("x").ok).toBe(false);
  });

  it("F3：domain verdict 必须带 domainId；adversarial 不填 domainId 仍合法", () => {
    expect(validateKnowledgeVerdict({ ...domainPass(), domainId: undefined }).ok).toBe(false);
    const adv = validateKnowledgeVerdict(adversarialPass());
    expect(adv.ok).toBe(true);
  });
});

/**
 * N29 再验收 P0-5（feedback §3 P0-5 条件 3 / §8 条件 6）：
 * legacy / 非 intake candidate 的"空 sourceBindingsDigest + 空 evidence"兼容路径必须删除。
 *
 * 反例：报告 §3 P0-5 指出 `knowledge-verdicts.ts` 只对被识别为 intake-bound 的 candidate 强制
 * 非空 evidence/digest，legacy candidate 仍可用空 digest + 空 evidence 晋升成 official。
 */
describe("N29 再验收 P0-5：canPromote 不再有空 digest / 空 evidence 兼容路径", () => {
  function legacyRows(plan: VerificationPlanRecord): KnowledgeVerdictRowRecord[] {
    return [
      {
        id: 1, planId: plan.id, tenantId: TENANT, checkId: "domain-1", candidateId: plan.candidateId,
        candidateRevision: 1, candidateHash: plan.candidateHash, principalId: "tenant:tenant-a:platform-admin",
        executionId: "task-d", kind: "domain", verdict: "pass", reviewerRole: "domain:expert",
        note: "verified", domainId: "mathematics", evidence: [], at: 1, rowVersion: 1,
        createdAt: new Date().toISOString(),
      },
      {
        id: 2, planId: plan.id, tenantId: TENANT, checkId: "adv-1", candidateId: plan.candidateId,
        candidateRevision: 1, candidateHash: plan.candidateHash, principalId: "worker:controller:adversarial",
        executionId: "task-a", kind: "adversarial", verdict: "pass", reviewerRole: "controller:adversarial",
        note: "no shortcut", evidence: [], at: 2, rowVersion: 1, createdAt: new Date().toISOString(),
      },
    ];
  }

  /** legacy candidate（无 meta.intake、无 IntakeEvidenceReference）——必须走同一非空绑定门禁。 */
  function legacyDraft(meta: Record<string, unknown> = {}): MemoryEntry {
    const draft = makeDraft();
    return { ...draft, meta: { ...draft.meta, ...meta } };
  }

  it("空 sourceBindingsDigest + 空 evidence 的 legacy candidate 一律拒绝（旧兼容路径已删除）", () => {
    const emptyHash = computeCandidateHash({ content, domains: ["mathematics"], evidence: [], effect: null });
    const plan = makePlan({ sourceBindingsDigest: "", candidateHash: emptyHash });
    const entry = legacyDraft({ evidence: [] });
    expect(isIntakeBoundCandidate(entry)).toBe(false);
    const decision = canPromote(entry, plan, legacyRows(plan));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/sourceBindingsDigest|source binding/i);
  });

  it("空 evidence（digest 为空数组摘要）的 legacy candidate 同样拒绝", () => {
    const emptyHash = computeCandidateHash({ content, domains: ["mathematics"], evidence: [], effect: null });
    const plan = makePlan({ sourceBindingsDigest: sourceBindingsDigestOf([]), candidateHash: emptyHash });
    const entry = legacyDraft({ evidence: [] });
    const decision = canPromote(entry, plan, legacyRows(plan));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/evidence/i);
  });

  it("meta.evidence 缺失（undefined）的 legacy candidate 拒绝", () => {
    const emptyHash = computeCandidateHash({ content, domains: ["mathematics"], evidence: [], effect: null });
    const plan = makePlan({ sourceBindingsDigest: sourceBindingsDigestOf([]), candidateHash: emptyHash });
    const draft = makeDraft();
    const meta = { ...draft.meta };
    delete meta["evidence"];
    const decision = canPromote({ ...draft, meta }, plan, legacyRows(plan));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/evidence/i);
  });

  it("显式非空 evidence + 匹配 digest 的 legacy candidate 才能晋升（正向基线）", () => {
    const plan = makePlan();
    expect(canPromote(makeDraft(), plan, legacyRows(plan))).toEqual({ ok: true });
  });
});

describe("rejectKnowledgeEntry（N22 2）", () => {
  it("draft → 追加 reject verdict + status archived（不删内容）", async () => {
    const store = makeStore([makeDraft()]);
    const r = await rejectKnowledgeEntry(store as never, "cand-1", "domain:supervisor", "evidence insufficient");
    expect(r).toEqual({ ok: true });
    const entry = store.rows.get("cand-1")!;
    expect(entry.status).toBe("archived");
    expect(entry.content).toBe(content);
    const verdicts = entry.meta.verdicts as unknown[];
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      kind: "domain",
      verdict: "reject",
      reviewerRole: "domain:supervisor",
      note: "evidence insufficient",
    });
  });
});

// --- 真实 PG 探针（P0-3/P1-2；宿主无 Docker 时 skip）---
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
const pgSuite = dockerAvailable ? describe : describe.skip;

pgSuite("knowledge promotion pg (real PostgreSQL, R3)", () => {
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

  async function seedDraft(id: string): Promise<void> {
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
        evidence: LEGACY_EVIDENCE,
        verdicts: [],
      },
    } as any);
  }

  async function seedPlan(planId: string, candidateId: string, status: VerificationPlanRecord["status"] = "satisfied"): Promise<void> {
    await pool.query(
      `INSERT INTO knowledge_verification_plans
         (id, tenant_id, candidate_id, candidate_revision, candidate_hash, required_domains, checks, source_bindings_digest, status)
       VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6::jsonb, $8, $7)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
      [
        planId,
        TENANT,
        candidateId,
        LEGACY_CANDIDATE_HASH,
        JSON.stringify(["mathematics"]),
        JSON.stringify([
          { checkId: "domain-1", kind: "domain", domainId: "mathematics", quorum: 1, eligiblePrincipals: ["tenant:tenant-a:platform-admin"], separationFrom: ["producer", "other-verifier"] },
          { checkId: "adv-1", kind: "adversarial", quorum: 1, eligiblePrincipals: ["worker:controller:adversarial"], separationFrom: ["producer", "other-verifier"] },
        ]),
        status,
        sourceBindingsDigestOf(LEGACY_EVIDENCE),
      ],
    );
  }

  it("concurrent verdicts on same check are idempotent; different payload same key is conflict", async () => {
    await seedDraft("pg-verdict-conc");
    await seedPlan("plan-verdict-conc", "pg-verdict-conc", "open");

    const authDomain = { principalId: "tenant:tenant-a:platform-admin", executionId: "task-d", roleId: "platform-admin" };
    const results = await Promise.all([
      recordKnowledgeVerdict(store, repo, "plan-verdict-conc", "domain-1", 1, domainPass(), authDomain, { tenantId: TENANT }),
      recordKnowledgeVerdict(store, repo, "plan-verdict-conc", "domain-1", 1, domainPass(), authDomain, { tenantId: TENANT }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const rows = await repo.listVerdictRows("plan-verdict-conc", TENANT);
    expect(rows).toHaveLength(1);

    const conflict = await recordKnowledgeVerdict(
      store, repo, "plan-verdict-conc", "domain-1", 1,
      domainPass({ note: "different payload", at: 999 }),
      authDomain, { tenantId: TENANT },
    );
    expect(conflict).toMatchObject({ ok: false, error: expect.stringContaining("conflict") });
  });

  it("recordKnowledgeVerdict without auth context is rejected", async () => {
    await seedDraft("pg-verdict-noauth");
    await seedPlan("plan-verdict-noauth", "pg-verdict-noauth", "open");

    const r = await recordKnowledgeVerdict(
      store, repo, "plan-verdict-noauth", "domain-1", 1, domainPass(), undefined as never, { tenantId: TENANT },
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("auth context") });
  });

  it("recordKnowledgeVerdict binds planId/checkId and rejects stale expectedCandidateRevision", async () => {
    await seedDraft("pg-verdict-bind");
    await seedPlan("plan-verdict-bind", "pg-verdict-bind", "open");
    const auth = makeAuth({ principalId: "tenant:tenant-a:platform-admin" });

    const missingPlan = await recordKnowledgeVerdict(store, repo, "nope", "domain-1", 1, domainPass(), auth, { tenantId: TENANT });
    expect(missingPlan).toMatchObject({ ok: false, error: expect.stringContaining("plan") });

    const missingCheck = await recordKnowledgeVerdict(store, repo, "plan-verdict-bind", "nope", 1, domainPass(), auth, { tenantId: TENANT });
    expect(missingCheck).toMatchObject({ ok: false, error: expect.stringContaining("check") });

    const stale = await recordKnowledgeVerdict(store, repo, "plan-verdict-bind", "domain-1", 0, domainPass(), auth, { tenantId: TENANT });
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining("expectedCandidateRevision") });

    const future = await recordKnowledgeVerdict(store, repo, "plan-verdict-bind", "domain-1", 2, domainPass(), auth, { tenantId: TENANT });
    expect(future).toMatchObject({ ok: false, error: expect.stringContaining("expectedCandidateRevision") });

    const ok = await recordKnowledgeVerdict(store, repo, "plan-verdict-bind", "domain-1", 1, domainPass(), auth, { tenantId: TENANT });
    expect(ok).toEqual({ ok: true });
    const entry = await store.get("pg-verdict-bind", { tenantId: TENANT });
    expect(entry?.meta?.version).toBe(1);
    expect(entry?.meta?.verdicts).toEqual([]);
    expect(await repo.listVerdictRows("plan-verdict-bind", TENANT)).toHaveLength(1);
  });

  it("promotion reads verdict rows only from plan table, not meta.verdicts", async () => {
    await seedDraft("pg-promote-meta-ignored");
    await seedPlan("plan-promote-meta-ignored", "pg-promote-meta-ignored", "satisfied");
    // 旧 meta.verdicts 自报数组即使“看起来合规”也不参与晋升判定。
    await pool.query(
      `UPDATE memory_entries SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{verdicts}', $2::jsonb)
       WHERE id = 'pg-promote-meta-ignored' AND tenant_id = $1`,
      [
        TENANT,
        JSON.stringify([
          domainPass({ principalId: "tenant:tenant-a:platform-admin", candidateRevision: 1 }),
          adversarialPass({ principalId: "worker:controller:adversarial", candidateRevision: 1 }),
        ]),
      ],
    );

    const auth = makeAuth({ principalId: "worker:memory-keeper" });
    const noRows = await promoteKnowledgeEntry(store, repo, "pg-promote-meta-ignored", "plan-promote-meta-ignored", 1, auth, { tenantId: TENANT });
    expect(noRows.ok).toBe(false);
    if (!noRows.ok) expect(noRows.error).toContain("quorum");

    const plan = await repo.getPlan("plan-promote-meta-ignored", TENANT);
    await repo.insertVerdictRow({
      planId: plan!.id,
      tenantId: TENANT,
      checkId: "domain-1",
      candidateId: "pg-promote-meta-ignored",
      candidateRevision: 1,
      candidateHash: plan!.candidateHash,
      principalId: "tenant:tenant-a:platform-admin",
      executionId: "task-d",
      kind: "domain",
      verdict: "pass",
      reviewerRole: "domain:expert",
      note: "verified",
      domainId: "mathematics",
      evidence: [],
      at: 1,
    });
    await repo.insertVerdictRow({
      planId: plan!.id,
      tenantId: TENANT,
      checkId: "adv-1",
      candidateId: "pg-promote-meta-ignored",
      candidateRevision: 1,
      candidateHash: plan!.candidateHash,
      principalId: "worker:controller:adversarial",
      executionId: "task-a",
      kind: "adversarial",
      verdict: "pass",
      reviewerRole: "controller:adversarial",
      note: "no shortcut",
      evidence: [],
      at: 2,
    });

    const r = await promoteKnowledgeEntry(store, repo, "pg-promote-meta-ignored", "plan-promote-meta-ignored", 1, auth, { tenantId: TENANT });
    expect(r).toEqual({ ok: true, id: "pg-promote-meta-ignored" });
    expect((await store.get("pg-promote-meta-ignored", { tenantId: TENANT }))?.status).toBe("official");
  });

  it("recordKnowledgeVerdict persists verdict rows and does not append meta.verdicts", async () => {
    await seedDraft("pg-verdict-rows");
    await seedPlan("plan-verdict-rows", "pg-verdict-rows", "open");

    const authDomain = { principalId: "tenant:tenant-a:platform-admin", executionId: "task-d", roleId: "platform-admin" };
    expect((await recordKnowledgeVerdict(store, repo, "plan-verdict-rows", "domain-1", 1, domainPass(), authDomain, { tenantId: TENANT })).ok).toBe(true);

    const entry = await store.get("pg-verdict-rows", { tenantId: TENANT });
    expect(entry?.meta?.version).toBe(1);
    expect(entry?.meta?.verdicts).toEqual([]);
    const rows = await repo.listVerdictRows("plan-verdict-rows", TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      planId: "plan-verdict-rows",
      checkId: "domain-1",
      candidateRevision: 1,
      principalId: "tenant:tenant-a:platform-admin",
      executionId: "task-d",
      domainId: "mathematics",
    });
  });

  it("promoteKnowledgeEntry requires planId and expectedCandidateRevision (CAS)", async () => {
    await seedDraft("pg-promote-cas");
    await seedPlan("plan-promote-cas", "pg-promote-cas", "satisfied");
    await repo.insertVerdictRow({
      planId: "plan-promote-cas",
      tenantId: TENANT,
      checkId: "domain-1",
      candidateId: "pg-promote-cas",
      candidateRevision: 1,
      candidateHash: LEGACY_CANDIDATE_HASH,
      principalId: "tenant:tenant-a:platform-admin",
      executionId: "task-d",
      kind: "domain",
      verdict: "pass",
      reviewerRole: "domain:expert",
      note: "verified",
      domainId: "mathematics",
      evidence: [],
      at: 1,
    });
    await repo.insertVerdictRow({
      planId: "plan-promote-cas",
      tenantId: TENANT,
      checkId: "adv-1",
      candidateId: "pg-promote-cas",
      candidateRevision: 1,
      candidateHash: LEGACY_CANDIDATE_HASH,
      principalId: "worker:controller:adversarial",
      executionId: "task-a",
      kind: "adversarial",
      verdict: "pass",
      reviewerRole: "controller:adversarial",
      note: "no shortcut",
      evidence: [],
      at: 2,
    });

    const auth = { principalId: "worker:memory-keeper", executionId: "task-mk", roleId: "memory-keeper" };
    const stale = await promoteKnowledgeEntry(store, repo, "pg-promote-cas", "plan-promote-cas", 99, auth);
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining("expectedCandidateRevision") });

    const ok = await promoteKnowledgeEntry(store, repo, "pg-promote-cas", "plan-promote-cas", 1, auth);
    expect(ok).toEqual({ ok: true, id: "pg-promote-cas" });

    const got = await store.get("pg-promote-cas", { tenantId: TENANT });
    expect(got?.status).toBe("official");
    expect(got?.meta?.promotion).toMatchObject({ promotedBy: "memory-keeper", planId: "plan-promote-cas" });
    // 同事务索引 outbox 已入队
    const outbox = await pool.query(`SELECT * FROM side_effect_outbox WHERE key = 'promotion-index:${TENANT}:pg-promote-cas:plan-promote-cas'`);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]).toMatchObject({ kind: "promotion-index", status: "pending" });
  });
});

// ─── N29 Task 5：evidence / plan / promotion 硬化（pure 判据） ──────────

describe("N29 intake candidate promotion hardening（pure）", () => {
  const INTAKE_CONTENT = "The sum of the interior angles of a triangle equals 180 degrees.";
  const REV = "rev-n29-1";
  const SUB = "sub-n29-1";
  const POLICY_DIGEST = "c".repeat(64);
  const PRODUCER = "worker:extractor:producer";
  const DOMAIN_REVIEWER = "worker:domain:mathematics-reviewer";
  const ADVERSARIAL_REVIEWER = "worker:controller:adversarial";
  const PROMOTER = "worker:memory-keeper";

  const evidenceRef = {
    sourceSubscriptionId: SUB,
    sourceRevisionId: REV,
    representation: "normalized-text" as const,
    locator: { start: 0, end: INTAKE_CONTENT.length },
    quoteHash: "a".repeat(64),
    artifactHash: "b".repeat(64),
    policyDecisionDigest: POLICY_DIGEST,
  };

  const intakeBinding = {
    sourceSubscriptionId: SUB,
    sourceRevisionId: REV,
    representation: "normalized-text" as const,
    artifactHash: evidenceRef.artifactHash,
    policyDecisionDigest: POLICY_DIGEST,
    tenantId: TENANT,
    space: "space-a",
    domainId: "mathematics",
    producerPrincipalId: PRODUCER,
  };

  function intakeCandidate(over: { evidence?: unknown[]; intake?: unknown } = {}): MemoryEntry {
    const evidence = over.evidence ?? [evidenceRef];
    return {
      id: "cand-n29",
      tenantId: TENANT,
      kind: "domain-fact",
      anchors: ["mathematics"],
      content: INTAKE_CONTENT,
      status: "draft",
      meta: {
        version: 1,
        spaceScope: { space: "space-a", visibility: "private" },
        domains: ["mathematics"],
        evidence,
        intake: over.intake ?? intakeBinding,
        provenance: buildKnowledgeProvenance({
          content: INTAKE_CONTENT,
          sourceTaskId: "run-n29",
          producerRole: PRODUCER,
          producerModel: "deepseek-v4-flash",
          sourceRefs: [`source-revision:${REV}`],
        }),
        verdicts: [],
      },
    };
  }

  function intakePlan(over: Partial<VerificationPlanRecord> = {}): VerificationPlanRecord {
    const evidence = [evidenceRef];
    return {
      id: "plan-n29",
      tenantId: TENANT,
      candidateId: "cand-n29",
      candidateRevision: 1,
      candidateHash: computeCandidateHash({ content: INTAKE_CONTENT, domains: ["mathematics"], evidence, effect: null }),
      requiredDomains: ["mathematics"],
      checks: [
        { checkId: "domain:mathematics", kind: "domain", domainId: "mathematics", quorum: 1, eligiblePrincipals: [DOMAIN_REVIEWER], separationFrom: [PRODUCER, ADVERSARIAL_REVIEWER, PROMOTER] },
        { checkId: "adversarial", kind: "adversarial", quorum: 1, eligiblePrincipals: [ADVERSARIAL_REVIEWER], separationFrom: [PRODUCER, DOMAIN_REVIEWER, PROMOTER] },
      ],
      sourceBindingsDigest: sourceBindingsDigestOf(evidence),
      status: "satisfied",
      rowVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...over,
    };
  }

  function passRows(plan: VerificationPlanRecord): KnowledgeVerdictRowRecord[] {
    return [
      { id: 1, planId: plan.id, tenantId: TENANT, checkId: "domain:mathematics", candidateId: plan.candidateId, candidateRevision: 1, candidateHash: plan.candidateHash, principalId: DOMAIN_REVIEWER, executionId: "run-domain", kind: "domain", verdict: "pass", reviewerRole: "domain:mathematics", note: "quote matches", domainId: "mathematics", evidence: [], at: 1, rowVersion: 1, createdAt: new Date().toISOString() },
      { id: 2, planId: plan.id, tenantId: TENANT, checkId: "adversarial", candidateId: plan.candidateId, candidateRevision: 1, candidateHash: plan.candidateHash, principalId: ADVERSARIAL_REVIEWER, executionId: "run-adv", kind: "adversarial", verdict: "pass", reviewerRole: "controller:adversarial", note: "no leap", evidence: [], at: 2, rowVersion: 1, createdAt: new Date().toISOString() },
    ];
  }

  it("detects N29 intake candidates by meta.intake or exact evidence shape", () => {
    expect(isIntakeBoundCandidate(intakeCandidate())).toBe(true);
    expect(isIntakeBoundCandidate(intakeCandidate({ intake: undefined }))).toBe(true); // evidence 形状即可判别
    expect(isIntakeBoundCandidate(makeDraft())).toBe(false);
  });

  it("baseline: a fully bound N29 candidate can be promoted", () => {
    const plan = intakePlan();
    expect(canPromote(intakeCandidate(), plan, passRows(plan))).toEqual({ ok: true });
  });

  it("rejects a N29 candidate whose plan carries an empty sourceBindingsDigest（legacy path removed）", () => {
    const plan = intakePlan({ sourceBindingsDigest: "" });
    expect(canPromote(intakeCandidate(), plan, passRows(plan))).toEqual({
      ok: false,
      reason: expect.stringContaining("source binding"),
    });
  });

  it("rejects an evidence-free N29 candidate（plan §5 Task 5 Step 1 red case）", () => {
    // 空 evidence + 空 digest：先在 source binding 门禁翻红。
    const emptyDigestPlan = intakePlan({ sourceBindingsDigest: "" });
    expect(canPromote(intakeCandidate({ evidence: [] }), emptyDigestPlan, passRows(emptyDigestPlan))).toEqual({
      ok: false,
      reason: expect.stringContaining("source binding"),
    });
    // 空 evidence + 非空 digest：在 evidence 门禁翻红。
    const digestOnlyPlan = intakePlan({ sourceBindingsDigest: sourceBindingsDigestOf([]) });
    expect(canPromote(intakeCandidate({ evidence: [] }), digestOnlyPlan, passRows(digestOnlyPlan))).toEqual({
      ok: false,
      reason: expect.stringContaining("evidence"),
    });
  });

  it("rejects invalid / mismatched evidence references on a N29 candidate", () => {
    // source binding 门禁先于 candidateHash 比较：evidence 自身非法即拒（错 representation）。
    const badRepresentation = [{ ...evidenceRef, representation: "raw-bytes" }];
    expect(canPromote(
      intakeCandidate({ evidence: badRepresentation }),
      intakePlan({ sourceBindingsDigest: sourceBindingsDigestOf(badRepresentation) }),
      [],
    )).toMatchObject({ ok: false, reason: expect.stringMatching(/evidence|representation/i) });

    // evidence 与 meta.intake 的 revision 不一致
    const otherRevision = [{ ...evidenceRef, sourceRevisionId: "rev-other" }];
    expect(canPromote(
      intakeCandidate({ evidence: otherRevision }),
      intakePlan({ sourceBindingsDigest: sourceBindingsDigestOf(otherRevision) }),
      [],
    )).toMatchObject({ ok: false, reason: expect.stringMatching(/sourceRevisionId/i) });

    // artifactHash / policyDecisionDigest 与 meta.intake 不一致
    const otherArtifact = [{ ...evidenceRef, artifactHash: "e".repeat(64) }];
    expect(canPromote(
      intakeCandidate({ evidence: otherArtifact }),
      intakePlan({ sourceBindingsDigest: sourceBindingsDigestOf(otherArtifact) }),
      [],
    )).toMatchObject({ ok: false, reason: expect.stringMatching(/artifactHash/i) });
  });

  it("rejects a N29 plan missing the domain or adversarial check, or letting the producer self-review", () => {
    const noAdv = intakePlan({ checks: [intakePlan().checks[0]] });
    expect(canPromote(intakeCandidate(), noAdv, [passRows(noAdv)[0]]))
      .toMatchObject({ ok: false, reason: expect.stringContaining("adversarial") });

    const noDomain = intakePlan({ checks: [intakePlan().checks[1]] });
    expect(canPromote(intakeCandidate(), noDomain, [passRows(noDomain)[1]]))
      .toMatchObject({ ok: false, reason: expect.stringContaining("domain check") });

    const selfReview = intakePlan();
    selfReview.checks = selfReview.checks.map((c) => ({ ...c, eligiblePrincipals: [...c.eligiblePrincipals, PRODUCER] }));
    expect(canPromote(intakeCandidate(), selfReview, passRows(selfReview)))
      .toMatchObject({ ok: false, reason: expect.stringContaining("producer principal") });
  });

  it("rejects a N29 candidate without a well-formed meta.intake binding", () => {
    const plan = intakePlan();
    expect(canPromote(intakeCandidate({ intake: { sourceRevisionId: REV } }), plan, passRows(plan)))
      .toMatchObject({ ok: false, reason: expect.stringContaining("meta.intake") });
  });

  it("computeVerificationPlanHash refuses to produce an uncovered plan hash", () => {
    expect(() => computeVerificationPlanHash({
      content: INTAKE_CONTENT, domains: ["mathematics"], evidence: [],
      policyDecisionDigest: POLICY_DIGEST, sourceRevisionId: REV,
    })).toThrow(/evidence/i);

    expect(() => computeVerificationPlanHash({
      content: INTAKE_CONTENT, domains: ["mathematics"], evidence: [evidenceRef],
      policyDecisionDigest: "d".repeat(64), sourceRevisionId: REV,
    })).toThrow(/policyDecisionDigest/);

    expect(() => computeVerificationPlanHash({
      content: INTAKE_CONTENT, domains: ["mathematics"], evidence: [evidenceRef],
      policyDecisionDigest: POLICY_DIGEST, sourceRevisionId: "rev-other",
    })).toThrow(/sourceRevisionId/);

    expect(computeVerificationPlanHash({
      content: INTAKE_CONTENT, domains: ["mathematics"], evidence: [evidenceRef],
      policyDecisionDigest: POLICY_DIGEST, sourceRevisionId: REV,
    })).toBe(computeCandidateHash({ content: INTAKE_CONTENT, domains: ["mathematics"], evidence: [evidenceRef], effect: null }));
  });

  it("createVerificationPlan rejects empty evidence / empty digest / missing role separation before touching the DB", async () => {
    let queried = 0;
    const executor = {
      async query() {
        queried += 1;
        return { rowCount: 0, rows: [] };
      },
    } as never;
    const base = {
      planId: "plan-n29-new",
      tenantId: TENANT,
      candidateId: "cand-n29",
      candidateRevision: 1,
      content: INTAKE_CONTENT,
      requiredDomains: ["mathematics"],
      policyDecisionDigest: POLICY_DIGEST,
      sourceRevisionId: REV,
      checks: intakePlan().checks,
    };

    expect(await createVerificationPlan({ ...base, evidence: [] }, executor))
      .toMatchObject({ ok: false, error: expect.stringMatching(/evidence/i) });
    expect(await createVerificationPlan({ ...base, evidence: [{ sourceId: "s", locator: "l" }] }, executor))
      .toMatchObject({ ok: false, error: expect.stringMatching(/evidence/i) });
    expect(await createVerificationPlan({ ...base, evidence: [evidenceRef], requiredDomains: [] }, executor))
      .toMatchObject({ ok: false, error: expect.stringMatching(/requiredDomains/i) });
    expect(await createVerificationPlan({ ...base, evidence: [evidenceRef], sourceRevisionId: "" }, executor))
      .toMatchObject({ ok: false, error: expect.stringMatching(/sourceRevisionId/i) });
    expect(await createVerificationPlan({ ...base, evidence: [evidenceRef], policyDecisionDigest: "nope" }, executor))
      .toMatchObject({ ok: false, error: expect.stringMatching(/policyDecisionDigest/i) });
    expect(await createVerificationPlan({ ...base, evidence: [evidenceRef], checks: [base.checks[0]] }, executor))
      .toMatchObject({ ok: false, error: expect.stringMatching(/adversarial/i) });
    expect(await createVerificationPlan({ ...base, evidence: [evidenceRef], checks: [base.checks[1]] }, executor))
      .toMatchObject({ ok: false, error: expect.stringMatching(/domain check/i) });
    // domain 与 adversarial 的 eligible principal 不得重叠（职责分离）
    expect(await createVerificationPlan({
      ...base,
      evidence: [evidenceRef],
      checks: [base.checks[0], { ...base.checks[1], eligiblePrincipals: [DOMAIN_REVIEWER] }],
    }, executor)).toMatchObject({ ok: false, error: expect.stringMatching(/both domain and adversarial/i) });

    // 全部在写库前 fail closed：零 SQL。
    expect(queried).toBe(0);
  });
});
