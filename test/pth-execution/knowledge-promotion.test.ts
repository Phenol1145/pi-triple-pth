import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { Pool } from "pg";
import {
  buildKnowledgeProvenance,
  DEFAULT_TENANT_ID,
  MEMORY_SCHEMA_SQL,
  PgMemoryStore,
  PromotionConflictError,
  type MemoryEntry,
} from "@away_from/pth-memory";
import {
  canPromote,
  validateKnowledgeVerdict,
  type KnowledgeVerdict,
} from "../../src/pth/execution/knowledge-verdicts.js";
import {
  promoteKnowledgeEntry,
  recordKnowledgeVerdict,
  rejectKnowledgeEntry,
} from "../../src/pth/execution/knowledge-promotion.js";

/**
 * K4 Phase 4（N22）：候选验证与晋升闭环。
 * fake store 支持 get/update/write——write 时把 status/meta 更新（对齐设计 5 的 fake store 契约）。
 */
function makeStore(initial: MemoryEntry[] = []) {
  const rows = new Map<string, MemoryEntry>();
  const writeCalls: Array<{ entry: MemoryEntry; opts?: { force?: boolean; reason?: string; createdBy?: string } }> = [];
  const promoteCalls: Array<{
    id: string; tenantId: string; expectedRevision: number;
    promotionMeta: { promotedBy: string; principalId?: string; note?: string; promotedAt: number; verdicts?: unknown };
    opts?: { createdBy?: string; reason?: string; evaluate?: (entry: MemoryEntry) => { ok: true } | { ok: false; reason: string } };
  }> = [];
  for (const e of initial) rows.set(e.id, structuredClone(e));
  return {
    rows,
    writeCalls,
    promoteCalls,
    async get(id: string, opts?: { tenantId?: string }) {
      const e = rows.get(id);
      if (!e) return undefined;
      if (opts?.tenantId && e.tenantId && e.tenantId !== opts.tenantId) return undefined;
      return structuredClone(e);
    },
    async update(
      id: string,
      patch: Partial<MemoryEntry> & { meta?: Record<string, unknown> },
      opts?: { tenantId?: string },
    ) {
      const e = rows.get(id);
      if (!e) throw new Error(`entry not found in tenant ${opts?.tenantId ?? "default"}`);
      if (opts?.tenantId && e.tenantId && e.tenantId !== opts.tenantId) {
        throw new Error(`entry not found in tenant ${opts.tenantId}`);
      }
      if (patch.content !== undefined) e.content = patch.content;
      if (patch.status !== undefined) e.status = patch.status;
      if (patch.meta !== undefined) e.meta = { ...(e.meta ?? {}), ...patch.meta };
    },
    async write(entry: MemoryEntry, opts?: { force?: boolean; reason?: string; createdBy?: string }) {
      writeCalls.push({ entry: structuredClone(entry), opts });
      rows.set(entry.id, structuredClone(entry));
    },
    async promoteOfficial(
      id: string,
      tenantId: string,
      expectedRevision: number,
      promotionMeta: { promotedBy: string; principalId?: string; note?: string; promotedAt: number; verdicts?: unknown },
      opts?: { createdBy?: string; reason?: string; evaluate?: (entry: MemoryEntry) => { ok: true } | { ok: false; reason: string } },
    ) {
      promoteCalls.push({ id, tenantId, expectedRevision, promotionMeta: structuredClone(promotionMeta), opts });
      const e = rows.get(id);
      if (!e) throw new PromotionConflictError(`entry not found in tenant ${tenantId}`);
      if (e.tenantId && e.tenantId !== tenantId) throw new PromotionConflictError(`entry not found in tenant ${tenantId}`);
      if (e.status === "official") {
        const promotion = e.meta?.promotion as { promotedBy?: unknown } | undefined;
        if (promotion && promotion.promotedBy === promotionMeta.promotedBy) return { ok: true, id };
        throw new PromotionConflictError(`entry is already official but not promoted by ${promotionMeta.promotedBy}`);
      }
      if (e.status !== "draft") throw new PromotionConflictError("only draft knowledge can be promoted");
      const currentVersion = e.meta?.["version"];
      if (currentVersion !== expectedRevision) {
        throw new PromotionConflictError(`expectedRevision ${expectedRevision} does not match current version ${String(currentVersion)}`);
      }
      if (opts?.evaluate) {
        const decision = opts.evaluate(structuredClone(e));
        if (!decision.ok) throw new PromotionConflictError(decision.reason);
      }
      const nextVersion = typeof currentVersion === "number" ? currentVersion + 1 : 2;
      e.status = "official";
      e.meta = {
        ...(e.meta ?? {}),
        version: nextVersion,
        promotion: { ...promotionMeta, verdicts: (e.meta as Record<string, unknown> | undefined)?.["verdicts"] ?? [] },
      };
      return { ok: true, id };
    },
  };
}

function makeDraft(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const content = overrides.content ?? "The Earth orbits the Sun.";
  const producerRole = "developer";
  return {
    id: "cand-1",
    tenantId: "default",
    kind: "task-insight",
    anchors: ["science"],
    content,
    status: "draft",
    meta: {
      version: 1,
      provenance: buildKnowledgeProvenance({
        content,
        sourceTaskId: "task-1",
        producerRole,
        producerModel: "deepseek-v4-flash",
        sourceRefs: ["task:task-1"],
      }),
      verdicts: [] as KnowledgeVerdict[],
    },
    ...overrides,
  };
}

function domainPass(reviewerRole = "domain:expert", overrides: Partial<KnowledgeVerdict> = {}): KnowledgeVerdict {
  return {
    kind: "domain",
    verdict: "pass",
    reviewerRole,
    note: "domain evidence verified",
    at: 1,
    principalId: "tenant:tenant-a:platform-admin",
    domainId: "mathematics",
    candidateRevision: 1,
    ...overrides,
  };
}

function adversarialPass(reviewerRole = "controller:adversarial", overrides: Partial<KnowledgeVerdict> = {}): KnowledgeVerdict {
  return {
    kind: "adversarial",
    verdict: "pass",
    reviewerRole,
    note: "no shortcut / pitfall covered",
    at: 2,
    principalId: "worker:controller:adversarial",
    candidateRevision: 1,
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

  it("F3：optional 字段形状非法 → 拒绝", () => {
    expect(validateKnowledgeVerdict({ ...domainPass(), principalId: "" }).ok).toBe(false);
    expect(validateKnowledgeVerdict({ ...domainPass(), executionId: " " }).ok).toBe(false);
    expect(validateKnowledgeVerdict({ ...domainPass(), candidateRevision: Number.NaN }).ok).toBe(false);
    expect(validateKnowledgeVerdict({ ...domainPass(), domainId: "" }).ok).toBe(false);
    expect(validateKnowledgeVerdict({ ...domainPass(), evidence: ["ok", 7] }).ok).toBe(false);
    expect(validateKnowledgeVerdict({ ...domainPass(), evidence: ["ok", ""] }).ok).toBe(false);
  });

  it("F3：domain verdict 必须带 domainId；adversarial 不填 domainId 仍合法", () => {
    expect(validateKnowledgeVerdict({ ...domainPass(), domainId: undefined }).ok).toBe(false);
    const adv = validateKnowledgeVerdict(adversarialPass("controller:adversarial", { domainId: undefined }));
    expect(adv.ok).toBe(true);
  });
});

describe("recordKnowledgeVerdict（N22 2）", () => {
  it("仅 draft 可审：official/archived 拒绝", async () => {
    const store = makeStore([makeDraft({ status: "official" as const })]);
    const r = await recordKnowledgeVerdict(store as never, "cand-1", domainPass());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("draft");
  });

  it("非法 verdict 拒绝", async () => {
    const store = makeStore([makeDraft()]);
    const r = await recordKnowledgeVerdict(store as never, "cand-1", { ...domainPass(), note: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("note");
  });

  it("同 kind + reviewer 重复提交 → 幂等 ok 且不重复 append", async () => {
    const store = makeStore([makeDraft()]);
    const first = await recordKnowledgeVerdict(store as never, "cand-1", domainPass());
    const second = await recordKnowledgeVerdict(store as never, "cand-1", domainPass());
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    const entry = store.rows.get("cand-1")!;
    const verdicts = entry.meta.verdicts as unknown[];
    expect(verdicts).toHaveLength(1);
  });

  it("producer 自审 → 拒绝（reviewerRole === provenance.producerRole）", async () => {
    const store = makeStore([makeDraft()]);
    const r = await recordKnowledgeVerdict(store as never, "cand-1", domainPass("developer"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("producer");
    expect((store.rows.get("cand-1")!.meta.verdicts as unknown[])).toHaveLength(0);
  });

  it("F3：candidateRevision 自动取 entry.meta.version（调用方不可覆盖）", async () => {
    const store = makeStore([makeDraft()]);
    const r = await recordKnowledgeVerdict(store as never, "cand-1", domainPass("domain:expert", { candidateRevision: 99 }));
    expect(r).toEqual({ ok: true });
    const verdicts = store.rows.get("cand-1")!.meta.verdicts as KnowledgeVerdict[];
    expect(verdicts[0].candidateRevision).toBe(1);
  });

  it("F3：opts.principalId/domainId 作为服务端盖章写入 verdict", async () => {
    const store = makeStore([makeDraft()]);
    const verdict: KnowledgeVerdict = {
      kind: "domain",
      verdict: "pass",
      reviewerRole: "domain:expert",
      note: "ok",
      at: 1,
    };
    const r = await recordKnowledgeVerdict(store as never, "cand-1", verdict, {
      principalId: "tenant:tenant-a:platform-admin",
      domainId: "mathematics",
    });
    expect(r).toEqual({ ok: true });
    const verdicts = store.rows.get("cand-1")!.meta.verdicts as KnowledgeVerdict[];
    expect(verdicts[0]).toMatchObject({
      principalId: "tenant:tenant-a:platform-admin",
      domainId: "mathematics",
      candidateRevision: 1,
    });
  });

  it("entry 不存在 → 拒绝", async () => {
    const store = makeStore();
    const r = await recordKnowledgeVerdict(store as never, "nope", domainPass());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });
});

describe("canPromote / promoteKnowledgeEntry（N22 1/2）", () => {
  it("缺任一 pass → promote 拒绝", async () => {
    const store = makeStore([makeDraft()]);
    await recordKnowledgeVerdict(store as never, "cand-1", domainPass());
    const r = await promoteKnowledgeEntry(store as never, "cand-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("adversarial");
  });

  it("有 reject → promote 拒绝", async () => {
    const store = makeStore([makeDraft()]);
    await recordKnowledgeVerdict(store as never, "cand-1", domainPass());
    await recordKnowledgeVerdict(store as never, "cand-1", { kind: "adversarial", verdict: "reject", reviewerRole: "controller:adversarial", note: "pitfall missing", at: 3 });
    const r = await promoteKnowledgeEntry(store as never, "cand-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("reject");
  });

  it("F3：domain 与 adversarial principal 相同 → promote 拒绝", async () => {
    const store = makeStore([makeDraft()]);
    await recordKnowledgeVerdict(store as never, "cand-1", domainPass("domain:expert", { principalId: "worker:controller:adversarial" }));
    await recordKnowledgeVerdict(store as never, "cand-1", adversarialPass("controller:adversarial", { principalId: "worker:controller:adversarial" }));
    const r = await promoteKnowledgeEntry(store as never, "cand-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("principals");
  });

  it("F3：producer 自核验（principalId === provenance.producerRole）→ promote 拒绝", async () => {
    const entry = makeDraft();
    entry.meta = {
      ...entry.meta,
      verdicts: [domainPass("domain:expert", { principalId: "developer" }), adversarialPass()],
    };
    const store = makeStore([entry]);
    const r = await promoteKnowledgeEntry(store as never, "cand-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("producer");
  });

  it("F3：domain pass 缺 principalId 或 domainId → promote 拒绝", async () => {
    const noPrincipal = makeDraft();
    noPrincipal.meta = {
      ...noPrincipal.meta,
      verdicts: [
        { kind: "domain", verdict: "pass", reviewerRole: "domain:expert", note: "ok", at: 1, domainId: "mathematics", candidateRevision: 1 },
        adversarialPass(),
      ],
    };
    const r1 = promoteKnowledgeEntry(makeStore([noPrincipal]) as never, "cand-1");
    await expect(r1).resolves.toMatchObject({ ok: false, error: expect.stringContaining("principalId") });

    const noDomain = makeDraft();
    noDomain.meta = {
      ...noDomain.meta,
      verdicts: [
        { kind: "domain", verdict: "pass", reviewerRole: "domain:expert", note: "ok", at: 1, principalId: "tenant:tenant-a:platform-admin", candidateRevision: 1 },
        adversarialPass(),
      ],
    };
    const r2 = promoteKnowledgeEntry(makeStore([noDomain]) as never, "cand-1");
    await expect(r2).resolves.toMatchObject({ ok: false, error: expect.stringContaining("domainId") });
  });

  it("F3：adversarial pass 缺 principalId → promote 拒绝", async () => {
    const entry = makeDraft();
    entry.meta = {
      ...entry.meta,
      verdicts: [
        domainPass(),
        { kind: "adversarial", verdict: "pass", reviewerRole: "controller:adversarial", note: "ok", at: 2, candidateRevision: 1 },
      ],
    };
    const r = await promoteKnowledgeEntry(makeStore([entry]) as never, "cand-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("principalId");
  });

  it("F3：candidateRevision 不等于 entry.meta.version → promote 拒绝", async () => {
    const entry = makeDraft();
    entry.meta = {
      ...entry.meta,
      verdicts: [domainPass("domain:expert", { candidateRevision: 2 }), adversarialPass()],
    };
    const r = await promoteKnowledgeEntry(makeStore([entry]) as never, "cand-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("candidateRevision");
  });

  it("provenance 缺失/哈希不匹配 → canPromote 拒绝", () => {
    const good = makeDraft();
    const noVerdict = canPromote(good);
    expect(noVerdict.ok).toBe(false);
    if (!noVerdict.ok) expect(noVerdict.reason).toContain("domain");
    const noProv = makeDraft();
    (noProv.meta as Record<string, unknown>).provenance = undefined;
    const r = canPromote(noProv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("provenance");

    const badHash = makeDraft();
    (badHash.meta as Record<string, unknown>).provenance = buildKnowledgeProvenance({
      content: "tampered content",
      sourceTaskId: "task-1",
      producerRole: "developer",
      producerModel: "deepseek-v4-flash",
      sourceRefs: ["task:task-1"],
    });
    const r2 = canPromote(badHash);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain("provenance");
  });

  it("全链：两个不同 reviewer pass → promote → official + promotion meta + write force 调用", async () => {
    const store = makeStore([makeDraft()]);
    expect((await recordKnowledgeVerdict(store as never, "cand-1", domainPass())).ok).toBe(true);
    expect((await recordKnowledgeVerdict(store as never, "cand-1", adversarialPass())).ok).toBe(true);

    const r = await promoteKnowledgeEntry(store as never, "cand-1", { principalId: "worker:memory-keeper" });
    expect(r).toEqual({ ok: true, id: "cand-1" });

    const entry = store.rows.get("cand-1")!;
    expect(entry.status).toBe("official");
    expect(entry.meta.promotion).toMatchObject({
      promotedBy: "memory-keeper",
      principalId: "worker:memory-keeper",
      verdicts: [domainPass(), adversarialPass()],
    });
    expect((entry.meta.promotion as { promotedAt?: unknown }).promotedAt).toEqual(expect.any(Number));

    expect(store.writeCalls).toHaveLength(0); // 非原子 write 路径已删除
    expect(store.promoteCalls).toHaveLength(1);
    expect(store.promoteCalls[0]).toMatchObject({
      id: "cand-1",
      tenantId: "default",
      expectedRevision: 1,
      opts: { createdBy: "memory-keeper", reason: "knowledge-promotion" },
    });
    expect(store.promoteCalls[0].promotionMeta).toMatchObject({
      promotedBy: "memory-keeper",
      principalId: "worker:memory-keeper",
      promotedAt: expect.any(Number),
    });
  });

  it("promoterRole 显式传入 → 写入 createdBy/promotedBy/principalId", async () => {
    const store = makeStore([makeDraft()]);
    await recordKnowledgeVerdict(store as never, "cand-1", domainPass());
    await recordKnowledgeVerdict(store as never, "cand-1", adversarialPass());
    const r = await promoteKnowledgeEntry(store as never, "cand-1", { promoterRole: "memory-keeper", principalId: "worker:memory-keeper" });
    expect(r).toEqual({ ok: true, id: "cand-1" });
    expect(store.rows.get("cand-1")!.meta.promotion).toMatchObject({
      promotedBy: "memory-keeper",
      principalId: "worker:memory-keeper",
    });
  });

  it("F1 6.3 幂等重放：已 official 且 promotedBy===promoterRole → 直接 ok 且不重复写", async () => {
    const store = makeStore([makeDraft()]);
    await recordKnowledgeVerdict(store as never, "cand-1", domainPass());
    await recordKnowledgeVerdict(store as never, "cand-1", adversarialPass());

    const first = await promoteKnowledgeEntry(store as never, "cand-1");
    expect(first).toEqual({ ok: true, id: "cand-1" });
    expect(store.writeCalls).toHaveLength(0);
    expect(store.promoteCalls).toHaveLength(1);

    const second = await promoteKnowledgeEntry(store as never, "cand-1");
    expect(second).toEqual({ ok: true, id: "cand-1" });
    expect(store.writeCalls).toHaveLength(0);
    expect(store.promoteCalls).toHaveLength(2); // replay 也走 CAS（锁内判定幂等），但不重复写

    const entry = store.rows.get("cand-1")!;
    expect(entry.status).toBe("official");
    expect((entry.meta.promotion as { promotedBy?: unknown }).promotedBy).toBe("memory-keeper");
  });

  it("F1 6.3 幂等重放：official 但无本 promoter 记录 → 拒绝", async () => {
    const officialWithoutPromotion = makeDraft({ status: "official" as const });
    const store = makeStore([officialWithoutPromotion]);
    const r = await promoteKnowledgeEntry(store as never, "cand-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not promoted by memory-keeper");
    expect(store.writeCalls).toHaveLength(0);
  });

  it("F1 6.3 幂等重放：official 但 promotedBy 与 promoterRole 不同 → 拒绝", async () => {
    const entry = makeDraft({ status: "official" as const });
    entry.meta = {
      ...entry.meta,
      promotion: { promotedBy: "other-keeper", promotedAt: 1, verdicts: [] },
    };
    const store = makeStore([entry]);
    const r = await promoteKnowledgeEntry(store as never, "cand-1", { promoterRole: "memory-keeper" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not promoted by memory-keeper");
    expect(store.writeCalls).toHaveLength(0);
  });
});

describe("rejectKnowledgeEntry（N22 2）", () => {
  it("draft → 追加 reject verdict + status archived（不删内容）", async () => {
    const store = makeStore([makeDraft()]);
    const r = await rejectKnowledgeEntry(store as never, "cand-1", "domain:supervisor", "evidence insufficient");
    expect(r).toEqual({ ok: true });
    const entry = store.rows.get("cand-1")!;
    expect(entry.status).toBe("archived");
    expect(entry.content).toBe("The Earth orbits the Sun.");
    const verdicts = entry.meta.verdicts as unknown[];
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      kind: "domain",
      verdict: "reject",
      reviewerRole: "domain:supervisor",
      note: "evidence insufficient",
    });
  });

  it("非 draft → 拒绝", async () => {
    const store = makeStore([makeDraft({ status: "official" as const })]);
    const r = await rejectKnowledgeEntry(store as never, "cand-1", "domain:supervisor", "late reject");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("draft");
  });

  it("controller:adversarial 的 reject → kind=adversarial", async () => {
    const store = makeStore([makeDraft()]);
    await rejectKnowledgeEntry(store as never, "cand-1", "controller:adversarial", "pitfall missing");
    const verdicts = store.rows.get("cand-1")!.meta.verdicts as unknown[];
    expect(verdicts[0]).toMatchObject({ kind: "adversarial", verdict: "reject" });
  });
});

// --- 真实 PG 探针（P0-1 promotion CAS；宿主无 Docker 时 skip）---
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

pgSuite("knowledge promotion pg (real PostgreSQL)", () => {
  let container: PostgreSqlContainer;
  let pool: Pool;
  let store: PgMemoryStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(MEMORY_SCHEMA_SQL);
    store = new PgMemoryStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  async function seedDraft(id: string, content = "The Earth orbits the Sun."): Promise<void> {
    const provenance = buildKnowledgeProvenance({
      content,
      sourceTaskId: "task-1",
      producerRole: "developer",
      producerModel: "deepseek-v4-flash",
      sourceRefs: ["task:task-1"],
    });
    await store.write({
      id,
      kind: "domain-fact",
      anchors: ["science"],
      content,
      status: "draft",
      meta: { provenance, verdicts: [] },
    } as any);
  }

  async function seedVerdicts(id: string): Promise<void> {
    expect((await recordKnowledgeVerdict(store, id, {
      kind: "domain",
      verdict: "pass",
      reviewerRole: "domain:expert",
      note: "domain evidence verified",
      at: 1,
      principalId: "tenant:tenant-a:platform-admin",
      domainId: "mathematics",
    })).ok).toBe(true);
    expect((await recordKnowledgeVerdict(store, id, {
      kind: "adversarial",
      verdict: "pass",
      reviewerRole: "controller:adversarial",
      note: "no shortcut / pitfall covered",
      at: 2,
      principalId: "worker:controller:adversarial",
    })).ok).toBe(true);
  }

  it("promoteKnowledgeEntry uses atomic CAS and rejects stale expectedRevision", async () => {
    await seedDraft("pg-promote-cas");
    await seedVerdicts("pg-promote-cas");

    // 两条 verdict 各经 update 递增 version：draft v1 → v3；CAS 基线必须是 3。
    expect((await store.get("pg-promote-cas"))?.meta?.version).toBe(3);

    const stale = await promoteKnowledgeEntry(store, "pg-promote-cas", { expectedRevision: 1 });
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining("expectedRevision") });

    const ok = await promoteKnowledgeEntry(store, "pg-promote-cas", { expectedRevision: 3 });
    expect(ok).toEqual({ ok: true, id: "pg-promote-cas" });

    const got = await store.get("pg-promote-cas");
    expect(got?.status).toBe("official");
    expect(got?.meta?.version).toBe(4);
    expect((got?.meta?.promotion as { promotedBy?: unknown })?.promotedBy).toBe("memory-keeper");
  });

  it("concurrent promotions with same expectedRevision allow exactly one winner", async () => {
    await seedDraft("pg-promote-conc");
    await seedVerdicts("pg-promote-conc");

    const results = await Promise.all([
      promoteKnowledgeEntry(store, "pg-promote-conc", { expectedRevision: 3 }),
      promoteKnowledgeEntry(store, "pg-promote-conc", { expectedRevision: 3 }),
    ]);

    // 胜者晋升；另一事务在锁内看到 official + 同 promoter 的 promotion → 幂等 replay（不重复写）。
    expect(results.filter((r) => r.ok)).toHaveLength(2);

    const got = await store.get("pg-promote-conc");
    expect(got?.status).toBe("official");
    expect(got?.meta?.version).toBe(4); // 只晋升一次，version 不双增
    const history = await store.revisionHistory("pg-promote-conc");
    expect(history.map((h) => h.revision)).toEqual([1, 2, 3]);
    expect(history.filter((h) => h.reason === "knowledge-promotion")).toHaveLength(1);
  });

  it("promotion then second status mutation does not hit revision unique violation", async () => {
    await seedDraft("pg-promote-then-mutate");
    await seedVerdicts("pg-promote-then-mutate");

    const promoted = await promoteKnowledgeEntry(store, "pg-promote-then-mutate", { expectedRevision: 3 });
    expect(promoted).toEqual({ ok: true, id: "pg-promote-then-mutate" });

    // promotion 后第二次 status mutation（official → archived）：不得复现 23505。
    const beforeMutation = await store.get("pg-promote-then-mutate");
    await store.write({
      id: "pg-promote-then-mutate",
      kind: "domain-fact",
      anchors: ["science"],
      content: beforeMutation?.content ?? "The Earth orbits the Sun.",
      status: "archived",
      meta: {
        ...(beforeMutation?.meta ?? {}),
        mutation: "post-promotion",
      },
    } as any, { force: true, reason: "archive-after-promotion" });

    const got = await store.get("pg-promote-then-mutate");
    expect(got?.status).toBe("archived");
    expect(got?.meta?.version).toBe(5);
    const history = await store.revisionHistory("pg-promote-then-mutate");
    expect(history.map((h) => h.revision)).toEqual([1, 2, 3, 4]);
  });

  it("promotion writes meta.promotion and official revision in one transaction", async () => {
    await seedDraft("pg-promote-tx");
    await seedVerdicts("pg-promote-tx");

    let outboxCalls = 0;
    const promotionMeta = { promotedBy: "memory-keeper", promotedAt: Date.now() };

    // 可观察 hook 注入 outbox 写入失败 → 断言事务回滚（official 未写、promotion revision 未写）。
    await expect(
      store.promoteOfficial("pg-promote-tx", DEFAULT_TENANT_ID, 3, promotionMeta, {
        createdBy: "memory-keeper",
        reason: "knowledge-promotion",
        evaluate: canPromote,
        enqueueOutbox: async () => {
          outboxCalls += 1;
          throw new Error("outbox write failed");
        },
      }),
    ).rejects.toThrow("outbox write failed");

    const afterRollback = await store.get("pg-promote-tx");
    expect(afterRollback?.status).toBe("draft");
    expect(afterRollback?.meta?.version).toBe(3);
    expect((await store.revisionHistory("pg-promote-tx")).map((h) => h.revision)).toEqual([1, 2]);
    expect(outboxCalls).toBe(1);

    // 成功路径：official 状态、meta.promotion 与旧 revision 在同一事务提交。
    await expect(
      store.promoteOfficial("pg-promote-tx", DEFAULT_TENANT_ID, 3, promotionMeta, {
        createdBy: "memory-keeper",
        reason: "knowledge-promotion",
        evaluate: canPromote,
        enqueueOutbox: async () => {
          outboxCalls += 1;
        },
      }),
    ).resolves.toEqual({ ok: true, id: "pg-promote-tx" });

    const got = await store.get("pg-promote-tx");
    expect(got?.status).toBe("official");
    expect(got?.meta?.promotion).toMatchObject({ promotedBy: "memory-keeper" });
    const history = await store.revisionHistory("pg-promote-tx");
    expect(history.map((h) => h.revision)).toEqual([1, 2, 3]);
    expect(history[2]).toMatchObject({ status: "draft", reason: "knowledge-promotion" });
    expect(outboxCalls).toBe(2);
  });
});
