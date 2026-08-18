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
  validateKnowledgeVerdict,
  type KnowledgeVerdict,
  type KnowledgeVerdictRowRecord,
  type VerificationPlanRecord,
} from "../../src/pth/execution/knowledge-verdicts.js";
import {
  createPgKnowledgeVerificationRepo,
  promoteKnowledgeEntry,
  recordKnowledgeVerdict,
  rejectKnowledgeEntry,
  type KnowledgeServiceAuth,
  type KnowledgeVerificationRepo,
} from "../../src/pth/execution/knowledge-promotion.js";
import { createInMemoryPromoteOfficial } from "../helpers";

const TENANT = DEFAULT_TENANT_ID;
const content = "The Earth orbits the Sun.";

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
    candidateHash: computeCandidateHash({ content, domains: ["mathematics"], evidence: [], effect: null }),
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
    sourceBindingsDigest: "",
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
        verdicts: [],
      },
    } as any);
  }

  async function seedPlan(planId: string, candidateId: string, status: VerificationPlanRecord["status"] = "satisfied"): Promise<void> {
    await pool.query(
      `INSERT INTO knowledge_verification_plans
         (id, tenant_id, candidate_id, candidate_revision, candidate_hash, required_domains, checks, source_bindings_digest, status)
       VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6::jsonb, '', $7)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
      [
        planId,
        TENANT,
        candidateId,
        computeCandidateHash({ content, domains: ["mathematics"], evidence: [], effect: null }),
        JSON.stringify(["mathematics"]),
        JSON.stringify([
          { checkId: "domain-1", kind: "domain", domainId: "mathematics", quorum: 1, eligiblePrincipals: ["tenant:tenant-a:platform-admin"], separationFrom: ["producer", "other-verifier"] },
          { checkId: "adv-1", kind: "adversarial", quorum: 1, eligiblePrincipals: ["worker:controller:adversarial"], separationFrom: ["producer", "other-verifier"] },
        ]),
        status,
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
      candidateHash: computeCandidateHash({ content, domains: ["mathematics"], evidence: [], effect: null }),
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
      candidateHash: computeCandidateHash({ content, domains: ["mathematics"], evidence: [], effect: null }),
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
