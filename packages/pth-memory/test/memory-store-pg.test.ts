import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { Pool } from "pg";
import { buildKnowledgeProvenance, DEFAULT_TENANT_ID, PgMemoryStore, provenanceFromMeta, runReadOnlyQuery, withMemoryTenant } from "@away_from/pth-memory";
import { applySchema } from "../../../src/pth/kernel/storage/schema.js";
import {
  createPgKnowledgeVerificationRepo,
  promoteKnowledgeEntry,
  recordKnowledgeVerdict,
} from "../../../src/pth/execution/knowledge-promotion.js";
import { computeCandidateHash, sourceBindingsDigestOf } from "../../../src/pth/execution/knowledge-verdicts.js";

// --- Docker 可用性守卫（Global Constraints：无 docker 环境必须 SKIP 而非 FAIL）---
// 模式同 Task 1/2/3（pg.test.ts / schema.test.ts / task-store-pg.test.ts）：
// getContainerRuntimeClient() 内部执行 dockerode.info()，daemon 不可用时抛错 → 走 skip 分支。
// PTH_TEST_NO_DOCKER=1 强制模拟无 docker。守卫自身的单元测试已由 pg.test.ts 覆盖（全 suite 唯一），此处不重复定义。
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

suite("memory store pg", () => {
  let container: PostgreSqlContainer;
  let pool: Pool;
  let store: PgMemoryStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    // R3 后 promotion 服务需要 knowledge_verification_plans/knowledge_verdict_rows/side_effect_outbox；
    // 统一走 core applySchema（含 MEMORY_SCHEMA_SQL）。
    await applySchema(pool);
    store = new PgMemoryStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("write persists entry with anchors", async () => {
    await store.write({ id: "e1", kind: "fact", anchors: ["alpha"], content: "x", meta: {} } as any);
    const got = await store.get("e1");
    expect(got?.content).toBe("x");
  });

  it("retrieve by anchor", async () => {
    await store.write({ id: "e2", kind: "fact", anchors: ["beta"], content: "y", meta: {} } as any);
    const hits = await store.retrieve({ anchors: ["beta"] });
    expect(hits.map((h) => h.id)).toContain("e2");
  });

  it("update increments version (CAS)", async () => {
    await store.write({ id: "e3", kind: "fact", anchors: ["gamma"], content: "v1", meta: {} } as any);
    await store.update("e3", { content: "v2" });
    const got = await store.get("e3");
    expect(got?.content).toBe("v2");
    expect(got?.meta?.version).toBe(2);
  });

  it("update 事务化记 revision：默认 reason=update，opts.createdBy/reason 可覆盖", async () => {
    await store.write({ id: "upd-rev-1", kind: "fact", anchors: ["upd-rev"], content: "v1", meta: {} } as any);
    await store.update("upd-rev-1", { content: "v2" });
    await store.update("upd-rev-1", { content: "v3" }, { createdBy: "developer", reason: "revise" });

    const history = await store.revisionHistory("upd-rev-1");
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      entryId: "upd-rev-1",
      tenantId: "default",
      revision: 1,
      content: "v1",
      reason: "update",
    });
    expect(history[1]).toMatchObject({
      entryId: "upd-rev-1",
      tenantId: "default",
      revision: 2,
      content: "v2",
      createdBy: "developer",
      reason: "revise",
    });
  });

  it("update 幂等 no-op（patch 与旧值全同）不写历史且不递增 version", async () => {
    await store.write({ id: "upd-noop", kind: "fact", anchors: ["upd-noop"], content: "same", meta: { custom: "x" } } as any);
    await store.update("upd-noop", { content: "same", meta: { custom: "x" } });
    const got = await store.get("upd-noop");
    expect(got?.content).toBe("same");
    expect(got?.meta?.version).toBe(1);
    expect(await store.revisionHistory("upd-noop")).toEqual([]);
  });

  it("bumpHitCount does not change version", async () => {
    await store.write({ id: "e4", kind: "fact", anchors: ["delta"], content: "z", meta: {} } as any);
    await store.bumpHitCount("e4");
    await store.bumpHitCount("e4");
    const got = await store.get("e4");
    expect(got?.meta?.version).toBe(1);       // 版本不变（旁路）
    expect(got?.meta?.hitCount ?? 0).toBe(2); // 计数 +2
  });

  it("retrieve excludes drafts", async () => {
    await store.write({ id: "e5", kind: "fact", anchors: ["eps"], content: "d", status: "draft", meta: {} } as any);
    const all = await store.retrieve({ anchors: ["eps"] });
    expect(all.some((e) => e.id === "e5")).toBe(true);
    const noDrafts = await store.retrieve({ anchors: ["eps"], excludeDrafts: true });
    expect(noDrafts.some((e) => e.id === "e5")).toBe(false);
  });

  it("write idempotent rewrite: same id + same content + same version keeps version (FS 路径②)", async () => {
    // 对齐 FS write 路径②：content/status/effective meta 全同 → 重落库不递增版本、不写历史。
    await store.write({ id: "e6", kind: "fact", anchors: ["theta"], content: "idem", meta: { version: 1, sourceTraces: ["t1"] } } as any);
    await store.write({ id: "e6", kind: "fact", anchors: ["theta"], content: "idem", meta: { version: 1, sourceTraces: ["t1"] } } as any);
    const got = await store.get("e6");
    expect(got?.content).toBe("idem");
    expect(got?.meta?.version).toBe(1); // 幂等重落库不递增
    expect(got?.meta?.sourceTraces).toEqual(["t1"]);
    expect(await store.revisionHistory("e6")).toEqual([]);
  });

  it("write conflict merges caller meta (FS persist 整条写回)", async () => {
    await store.write({ id: "e7", kind: "fact", anchors: ["zeta"], content: "c1", meta: { sourceTraces: ["t1"] } } as any);
    await store.write({ id: "e7", kind: "fact", anchors: ["zeta"], content: "c2", meta: { sourceTraces: ["t1", "t2"] } } as any);
    const got = await store.get("e7");
    expect(got?.content).toBe("c2");
    expect(got?.meta?.version).toBe(2);                    // 新状态 → version+1
    expect(got?.meta?.sourceTraces).toEqual(["t1", "t2"]); // 调用方 meta 保留（旧+新）
  });

  it("write status/meta-only mutation increments version and writes old revision", async () => {
    await store.write({
      id: "r1-status-meta", kind: "fact", anchors: ["r1"], content: "same-content",
      status: "draft", meta: { version: 1, custom: "before" },
    } as any);
    const v1 = await store.get("r1-status-meta");
    expect(v1?.meta?.version).toBe(1);

    await store.write({
      id: "r1-status-meta", kind: "fact", anchors: ["r1"], content: "same-content",
      status: "official", meta: { version: 1, custom: "after" },
    } as any, { force: true, reason: "knowledge-promotion" });

    const v2 = await store.get("r1-status-meta");
    expect(v2?.status).toBe("official");
    expect(v2?.meta?.version).toBe(2);
    const history = await store.revisionHistory("r1-status-meta");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ revision: 1, content: "same-content", status: "draft" });
  });

  it("write three consecutive mutations produce distinct revisions without 23505", async () => {
    await store.write({
      id: "r1-three", kind: "fact", anchors: ["r1"], content: "same-content",
      status: "draft", meta: { version: 1 },
    } as any);
    const v1 = (await store.get("r1-three"))?.meta?.version;

    await store.write({
      id: "r1-three", kind: "fact", anchors: ["r1"], content: "same-content",
      status: "official", meta: { version: 1, mutation: "first" },
    } as any, { force: true, reason: "knowledge-promotion" });
    const v2 = (await store.get("r1-three"))?.meta?.version;

    await store.write({
      id: "r1-three", kind: "fact", anchors: ["r1"], content: "same-content",
      status: "archived", meta: { version: 2, mutation: "second" },
    } as any, { force: true, reason: "archive" });
    const v3 = (await store.get("r1-three"))?.meta?.version;

    // 复验原探针序列改为断言：{v1:1, v2:2, v3:3, revisions:[1,2]} 且无 23505。
    expect({ v1, v2, v3 }).toEqual({ v1: 1, v2: 2, v3: 3 });
    const history = await store.revisionHistory("r1-three");
    expect(history.map((h) => h.revision)).toEqual([1, 2]);
    expect(history[0].status).toBe("draft");
    expect(history[1].status).toBe("official");
  });

  it("write idempotent replay does not write history nor increment version", async () => {
    await store.write({
      id: "r1-idem", kind: "fact", anchors: ["r1"], content: "idem",
      status: "draft", meta: { version: 1, custom: "same" },
    } as any);
    await store.write({
      id: "r1-idem", kind: "fact", anchors: ["r1"], content: "idem",
      status: "draft", meta: { version: 1, custom: "same" },
    } as any);
    const got = await store.get("r1-idem");
    expect(got?.meta?.version).toBe(1);
    expect(await store.revisionHistory("r1-idem")).toEqual([]);
  });

  it("write then update then archive preserves monotonic versions and revisions", async () => {
    await store.write({
      id: "r1-wua", kind: "fact", anchors: ["r1"], content: "v1", meta: { version: 1 },
    } as any);
    await store.update("r1-wua", { content: "v2" });
    await store.update("r1-wua", { status: "archived" });

    const got = await store.get("r1-wua");
    expect(got?.content).toBe("v2");
    expect(got?.status).toBe("archived");
    expect(got?.meta?.version).toBe(3);
    const history = await store.revisionHistory("r1-wua");
    expect(history.map((h) => h.revision)).toEqual([1, 2]);
    expect(history[0].content).toBe("v1");
    expect(history[1].content).toBe("v2");
  });

  it("write with empty anchors is rejected by DB CHECK", async () => {
    await expect(
      store.write({ id: "e8", kind: "fact", anchors: [], content: "x", meta: {} } as any),
    ).rejects.toThrow(); // schema CHECK jsonb_array_length(anchors) > 0
  });

  it("H6：spaceScope/visibility/系统账本键不可经 update 覆盖", async () => {
    await store.write({
      id: "h6-1", kind: "fact", anchors: ["h6"],
      content: "v1", meta: { spaceScope: { space: "meta", visibility: "public" as const }, visibility: "public", custom: "old" },
    } as any);
    await store.update("h6-1", {
      content: "v2",
      meta: {
        spaceScope: { space: "dev", visibility: "private" },
        visibility: "private",
        version: 999,
        updatedAt: 1,
        hitCount: 999,
        notWriteBack: true,
        custom: "new",
      },
    });
    const got = await store.get("h6-1");
    expect(got?.content).toBe("v2");
    expect(got?.meta?.spaceScope).toEqual({ space: "meta", visibility: "public" });
    expect(got?.meta?.custom).toBe("new");
    expect(got?.meta?.version).toBe(2);          // 系统账本仍由 store 维护
    expect(got?.meta?.hitCount ?? 0).toBe(0);
    expect(got?.meta?.notWriteBack).toBe(false);
  });

  it("H6：sanitizeMetaPatch 纯函数语义", () => {
    const out = PgMemoryStore.sanitizeMetaPatch({
      spaceScope: { space: "x", visibility: "private" }, visibility: "private",
      version: 9, updatedAt: 1, hitCount: 5, notWriteBack: true, keep: 1,
    });
    expect(out).toEqual({ keep: 1 });
  });


  it("H3：runReadOnlyQuery 可见性谓词下推（DB 层过滤）", async () => {
    await store.write({
      id: "h3-public", kind: "fact", anchors: ["h3"], content: "pub",
      meta: { spaceScope: { space: "meta", visibility: "public" } },
    } as any);
    await store.write({
      id: "h3-private", kind: "fact", anchors: ["h3"], content: "priv",
      meta: { spaceScope: { space: "dev", visibility: "private" } },
    } as any);
    const childRows = await runReadOnlyQuery(
      pool,
      "SELECT id, meta FROM memory_entries WHERE anchors ? 'h3'",
      undefined,
      { currentSpace: "child", ancestors: ["child", "dev", "meta"] },
    ) as Array<{ id: string }>;
    expect(childRows.map((r) => r.id)).toContain("h3-public");
    expect(childRows.map((r) => r.id)).not.toContain("h3-private");
    const devRows = await runReadOnlyQuery(
      pool,
      "SELECT id, meta FROM memory_entries WHERE anchors ? 'h3'",
      undefined,
      { currentSpace: "dev", ancestors: ["dev", "meta"] },
    ) as Array<{ id: string }>;
    expect(devRows.map((r) => r.id).sort()).toEqual(["h3-private", "h3-public"]);
  });

  it("K1a：DEFAULT_TENANT_ID 导出为 default", () => {
    expect(DEFAULT_TENANT_ID).toBe("default");
  });

  it("K1a：write/get/retrieve/listIds 跨 tenant 隔离（缺省走 default）", async () => {
    await store.write({ id: "k1a-t1-default", kind: "fact", anchors: ["k1a-tenant"], content: "default", meta: {} } as any);
    await store.write({ id: "k1a-t1-other", kind: "fact", anchors: ["k1a-tenant"], content: "other", tenantId: "tenant-a", meta: {} } as any);

    // get：tenant 不符 → undefined
    expect((await store.get("k1a-t1-default"))?.content).toBe("default");
    expect(await store.get("k1a-t1-default", { tenantId: "tenant-a" })).toBeUndefined();
    expect((await store.get("k1a-t1-other", { tenantId: "tenant-a" }))?.content).toBe("other");
    expect(await store.get("k1a-t1-other")).toBeUndefined();

    // retrieve：缺省只回 default tenant；显式 tenant 只回本 tenant
    const defaults = await store.retrieve({ anchors: ["k1a-tenant"] });
    expect(defaults.map((e) => e.id)).toContain("k1a-t1-default");
    expect(defaults.map((e) => e.id)).not.toContain("k1a-t1-other");
    const others = await store.retrieve({ anchors: ["k1a-tenant"], tenantId: "tenant-a" });
    expect(others.map((e) => e.id)).toContain("k1a-t1-other");
    expect(others.map((e) => e.id)).not.toContain("k1a-t1-default");

    // listIds：缺省只列 default tenant
    const defaultIds = await store.listIds();
    expect(defaultIds).toContain("k1a-t1-default");
    expect(defaultIds).not.toContain("k1a-t1-other");
    const otherIds = await store.listIds({ tenantId: "tenant-a" });
    expect(otherIds).toContain("k1a-t1-other");
    expect(otherIds).not.toContain("k1a-t1-default");
  });

  it("K1a：update tenant 不符 0 行 → fail-closed 抛 entry not found in tenant", async () => {
    await store.write({ id: "k1a-t2-other", kind: "fact", anchors: ["k1a-tenant-upd"], content: "v1", tenantId: "tenant-a", meta: {} } as any);
    await expect(store.update("k1a-t2-other", { content: "v2" })).rejects.toThrow("entry not found in tenant default");
    await store.update("k1a-t2-other", { content: "v2" }, { tenantId: "tenant-a" });
    const got = await store.get("k1a-t2-other", { tenantId: "tenant-a" });
    expect(got?.content).toBe("v2");
  });

  it("K1a：bumpHitCount tenant 条件——错 tenant 不递增", async () => {
    await store.write({ id: "k1a-t3-other", kind: "fact", anchors: ["k1a-tenant-hit"], content: "h", tenantId: "tenant-a", meta: {} } as any);
    await store.bumpHitCount("k1a-t3-other"); // default tenant → 0 行
    let got = await store.get("k1a-t3-other", { tenantId: "tenant-a" });
    expect(got?.meta?.hitCount ?? 0).toBe(0);
    await store.bumpHitCount("k1a-t3-other", { tenantId: "tenant-a" });
    got = await store.get("k1a-t3-other", { tenantId: "tenant-a" });
    expect(got?.meta?.hitCount ?? 0).toBe(1);
  });

  it("K1a：incrementAggregate 默认 tenant 兼容 + tenant 条件不串写", async () => {
    await store.incrementAggregate("k1a-agg-default", "agg-kind", ["k1a-agg"], { n: 1 }, {});
    let got = await store.get("k1a-agg-default");
    expect(got?.kind).toBe("agg-kind");
    expect(JSON.parse(got?.content ?? "{}").n).toBe(1);

    // 同 id 但 tenant 不符：DO UPDATE 的 tenant 条件挡住——default 行不被串写
    await store.incrementAggregate("k1a-agg-default", "agg-kind", ["k1a-agg"], { n: 5 }, {}, { tenantId: "tenant-a" });
    got = await store.get("k1a-agg-default");
    expect(JSON.parse(got?.content ?? "{}").n).toBe(1);

    // 不同 id + 显式 tenant：写入本 tenant，default 不可见
    await store.incrementAggregate("k1a-agg-other", "agg-kind", ["k1a-agg"], { n: 2 }, {}, { tenantId: "tenant-a" });
    const other = await store.get("k1a-agg-other", { tenantId: "tenant-a" });
    expect(JSON.parse(other?.content ?? "{}").n).toBe(2);
    expect(await store.get("k1a-agg-other")).toBeUndefined();
  });

  it("K1a：构造 defaultTenantId 可覆盖缺省 default", async () => {
    const customStore = new PgMemoryStore(pool, { defaultTenantId: "tenant-custom" });
    await customStore.write({ id: "k1a-t4-custom", kind: "fact", anchors: ["k1a-tenant-custom"], content: "c", meta: {} } as any);
    expect(await customStore.get("k1a-t4-custom")).toBeDefined();
    expect(await store.get("k1a-t4-custom")).toBeUndefined();
    expect(await store.listIds({ tenantId: "tenant-custom" })).toContain("k1a-t4-custom");
  });

  it("K1b：write 事务化 append-only——首次写无历史，更新记旧版本", async () => {
    await store.write({ id: "k1b-rev-1", kind: "fact", anchors: ["k1b-rev"], content: "v1", meta: { version: 1 } } as any);
    expect(await store.revisionHistory("k1b-rev-1")).toEqual([]);

    await store.write({
      id: "k1b-rev-1", kind: "fact", anchors: ["k1b-rev"], content: "v2",
      meta: { version: 2 }, status: "official",
    } as any, { createdBy: "developer", reason: "update" });
    const history = await store.revisionHistory("k1b-rev-1");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      entryId: "k1b-rev-1",
      tenantId: "default",
      revision: 1,
      content: "v1",
      createdBy: "developer",
      reason: "update",
    });
    expect(history[0].anchors).toEqual(["k1b-rev"]);
  });

  it("K1b：幂等重写不产生 revision 行（content/status/meta 全同）", async () => {
    await store.write({ id: "k1b-rev-2", kind: "fact", anchors: ["k1b-rev"], content: "idem", meta: { version: 1 } } as any);
    await store.write({ id: "k1b-rev-2", kind: "fact", anchors: ["k1b-rev"], content: "idem", meta: { version: 1 } } as any);
    expect(await store.revisionHistory("k1b-rev-2")).toEqual([]);
    const got = await store.get("k1b-rev-2");
    expect(got?.meta?.version).toBe(1);
  });

  it("K1b：status/meta-only 变化（如 K4 晋升）也必须记 revision", async () => {
    await store.write({ id: "k1b-rev-2b", kind: "fact", anchors: ["k1b-rev"], content: "idem", status: "draft", meta: { version: 1, provenance: { sourceTaskId: "t1", producerRole: "solver", producerModel: "m", sourceRefs: ["task:t1"], contentHash: "h", createdAt: 1 } } } as any);
    await store.write({ id: "k1b-rev-2b", kind: "fact", anchors: ["k1b-rev"], content: "idem", status: "official", meta: { version: 1, provenance: { sourceTaskId: "t1", producerRole: "solver", producerModel: "m", sourceRefs: ["task:t1"], contentHash: "h", createdAt: 1 }, promotion: { promotedBy: "memory-keeper", promotedAt: 1 } } } as any, { force: true, reason: "knowledge-promotion" });
    const history = await store.revisionHistory("k1b-rev-2b");
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("draft");
    expect(history[0].reason).toBe("knowledge-promotion");
  });

  it("K1b：restoreRevision 恢复目标历史版本 + 自动记恢复前版本", async () => {
    await store.write({ id: "k1b-rev-3", kind: "fact", anchors: ["k1b-rev"], content: "v1", meta: { version: 1 } } as any);
    await store.write({ id: "k1b-rev-3", kind: "fact", anchors: ["k1b-rev"], content: "v2", meta: { version: 2 } } as any);
    await store.write({ id: "k1b-rev-3", kind: "fact", anchors: ["k1b-rev"], content: "v3", meta: { version: 3 } } as any);

    await store.restoreRevision("k1b-rev-3", 1, { createdBy: "admin" });

    const got = await store.get("k1b-rev-3");
    expect(got?.content).toBe("v1");
    expect(got?.meta?.restoredFromRevision).toBe(1);
    expect(got?.meta?.restoredAt).toEqual(expect.any(Number));

    const history = await store.revisionHistory("k1b-rev-3");
    // 历史：rev1=v1, rev2=v2, rev3=v3(恢复前当前版本自动记录)
    expect(history.map((h) => h.revision)).toEqual([1, 2, 3]);
    expect(history[2]).toMatchObject({ content: "v3", reason: "restore", createdBy: "admin" });
  });

  it("K1b：revisionHistory 跨 tenant 隔离（default 查不到另一 tenant 历史）", async () => {
    await store.write({ id: "k1b-rev-t", kind: "fact", anchors: ["k1b-rev-tenant"], content: "v1", tenantId: "tenant-a", meta: { version: 1 } } as any);
    await store.write({ id: "k1b-rev-t", kind: "fact", anchors: ["k1b-rev-tenant"], content: "v2", tenantId: "tenant-a", meta: { version: 2 } } as any);

    expect(await store.revisionHistory("k1b-rev-t")).toEqual([]);
    const history = await store.revisionHistory("k1b-rev-t", { tenantId: "tenant-a" });
    expect(history).toHaveLength(1);
    expect(history[0].tenantId).toBe("tenant-a");
    expect(history[0].content).toBe("v1");
  });

  it("K1b：official + PROVENANCE_REQUIRED_KINDS 写入门禁——meta.provenance 缺失/无效拒绝不落库", async () => {
    // N29 P0-4：official 领域知识写需先出示内部 authority（seed/migration）；本用例验证
    // authority 之后的 provenance 门禁仍然生效（两道门叠加，不互相掩盖）。
    const seedAuthority = { knowledgeOfficialAuthority: "seed-migration" } as any;
    await expect(
      store.write({ id: "k1b-prov-bad", kind: "domain-fact", anchors: ["k1b-prov"], content: "x", status: "official", meta: {} } as any, seedAuthority),
    ).rejects.toThrow(/provenance/);
    expect(await store.get("k1b-prov-bad")).toBeUndefined();

    const provenance = buildKnowledgeProvenance({
      content: "x", sourceTaskId: "t1", producerRole: "developer",
      producerModel: "deepseek-v4-flash", sourceRefs: ["task:t1"],
    });
    await store.write({
      id: "k1b-prov-ok", kind: "domain-fact", anchors: ["k1b-prov"], content: "x",
      status: "official", meta: { provenance },
    } as any, seedAuthority);
    expect((await store.get("k1b-prov-ok"))?.content).toBe("x");
    expect((await store.get("k1b-prov-ok"))?.meta.provenance).toEqual(provenance);
  });

  it("K1b：顶层平铺 provenance 不再被接受（只认 meta.provenance）", async () => {
    const flat = buildKnowledgeProvenance({
      content: "flat", sourceTaskId: "t1", producerRole: "developer",
      producerModel: "deepseek-v4-flash", sourceRefs: ["task:t1"],
    });
    await expect(
      store.write({
        id: "k1b-prov-flat", kind: "domain-fact", anchors: ["k1b-prov"],
        content: "flat", status: "official", meta: { ...flat },
      } as any, { knowledgeOfficialAuthority: "seed-migration" } as any),
    ).rejects.toThrow(/provenance/);
    expect(await store.get("k1b-prov-flat")).toBeUndefined();
  });

  it("K1b：draft 不强制 provenance", async () => {
    await store.write({ id: "k1b-prov-draft", kind: "domain-fact", anchors: ["k1b-prov"], content: "draft-x", status: "draft", meta: {} } as any);
    expect((await store.get("k1b-prov-draft"))?.status).toBe("draft");
  });

  // ── N29 L1（§1.6 P0-4）：official 知识只能由 Promotion Service 晋升 ────────────
  // 反例来源：docs/pth/n29-minimal-knowledge-intake-loop-feedback-plan.md §5 Task 1 Step 5。

  it("N29 P0-4：official domain 知识直写被拒（普通 store write / service 均无 authority）", async () => {
    const provenance = buildKnowledgeProvenance({
      content: "direct", sourceTaskId: "t-n29", producerRole: "developer",
      producerModel: "deepseek-v4-flash", sourceRefs: ["task:t-n29"],
    });
    await expect(
      store.write({
        id: "n29-direct-official", kind: "domain-fact", anchors: ["n29"],
        content: "direct", status: "official", meta: { provenance },
      } as any),
    ).rejects.toThrow(/official/);
    expect(await store.get("n29-direct-official")).toBeUndefined();

    await expect(
      store.write({
        id: "n29-direct-official-method", kind: "domain-method", anchors: ["n29"],
        content: "direct", status: "official", meta: { provenance },
      } as any),
    ).rejects.toThrow(/official/);
    expect(await store.get("n29-direct-official-method")).toBeUndefined();
  });

  it("N29 P0-4：platform-admin service 身份也不能绕过（store 层无 role 分支）", async () => {
    const provenance = buildKnowledgeProvenance({
      content: "admin", sourceTaskId: "t-admin", producerRole: "platform-admin",
      producerModel: "deepseek-v4-flash", sourceRefs: ["task:t-admin"],
    });
    // force=true（系统文档通道）不是 knowledge official authority——不得成为旁路
    await expect(
      store.write({
        id: "n29-admin-official", kind: "domain-fact", anchors: ["n29"],
        content: "admin", status: "official", meta: { provenance },
      } as any, { force: true, createdBy: "tenant:tenant-a:platform-admin" }),
    ).rejects.toThrow(/official/);
    expect(await store.get("n29-admin-official")).toBeUndefined();
  });

  it("N29 P0-4：draft → official 的 update 直写同样被拒", async () => {
    const provenance = buildKnowledgeProvenance({
      content: "upd", sourceTaskId: "t-upd", producerRole: "developer",
      producerModel: "deepseek-v4-flash", sourceRefs: ["task:t-upd"],
    });
    await store.write({
      id: "n29-update-official", kind: "domain-fact", anchors: ["n29"],
      content: "upd", status: "draft", meta: { provenance },
    } as any);
    await expect(store.update("n29-update-official", { status: "official" })).rejects.toThrow(/official/);
    expect((await store.get("n29-update-official"))?.status).toBe("draft");
  });

  it("N29 P0-4：incrementAggregate 不能伪造 official domain 知识", async () => {
    await expect(
      store.incrementAggregate("n29-agg-official", "domain-fact", ["n29"], { hits: 1 }, {}),
    ).rejects.toThrow(/official/);
    expect(await store.get("n29-agg-official")).toBeUndefined();
  });

  it("N29 P0-4：seed/migration 内部 authority 与 worker capability 分离且可写 official", async () => {
    const provenance = buildKnowledgeProvenance({
      content: "seeded", sourceTaskId: "seed", producerRole: "seed",
      producerModel: "seed", sourceRefs: ["seed:n29"],
    });
    await store.write({
      id: "n29-seed-official", kind: "domain-fact", anchors: ["n29"],
      content: "seeded", status: "official", meta: { provenance },
    } as any, { knowledgeOfficialAuthority: "seed-migration" } as any);
    expect((await store.get("n29-seed-official"))?.status).toBe("official");
  });

  // ── N29 再验收 P0-5（feedback §3 P0-5 / §8 条件 6）：official 知识的剩余旁路 ──────────
  // 反例来源：docs/pth/n29-minimal-intake-reacceptance-feedback.md §2.3 探针
  // `rawStoreOfficial = { status: "official", kind: "task-insight" }` 与 §3 P0-5 的
  // "promoteOfficial() evaluator 可省略" / "capability facade 仍公开晋升原语"。

  it("N29 P0-5：promoteOfficial 不提供 evaluator 时抛错（门禁不可省略，零写）", async () => {
    const provenance = buildKnowledgeProvenance({
      content: "no-evaluator", sourceTaskId: "t-p05", producerRole: "developer",
      producerModel: "deepseek-v4-flash", sourceRefs: ["task:t-p05"],
    });
    await store.write({
      id: "n29-p05-no-evaluator", kind: "domain-fact", anchors: ["n29-p05"],
      content: "no-evaluator", status: "draft", meta: { provenance },
    } as any);

    await expect(
      store.promoteOfficial("n29-p05-no-evaluator", DEFAULT_TENANT_ID, 1, {
        promotedBy: "memory-keeper", promotedAt: Date.now(),
      }),
    ).rejects.toThrow(/evaluator/i);
    // 空 opts（既不传 evaluate 也不传 evaluateAsync）同样被拒
    await expect(
      store.promoteOfficial("n29-p05-no-evaluator", DEFAULT_TENANT_ID, 1, {
        promotedBy: "memory-keeper", promotedAt: Date.now(),
      }, { createdBy: "memory-keeper" }),
    ).rejects.toThrow(/evaluator/i);

    const after = await store.get("n29-p05-no-evaluator");
    expect(after?.status).toBe("draft");
    expect(after?.meta?.promotion).toBeUndefined();
    expect(await store.revisionHistory("n29-p05-no-evaluator")).toHaveLength(0);
  });

  it("N29 P0-5：task-insight / tool-function official 直写被拒（raw store 旁路关闭）", async () => {
    for (const kind of ["task-insight", "tool-function"]) {
      const content = `raw-official-${kind}`;
      const provenance = buildKnowledgeProvenance({
        content, sourceTaskId: "t-p05-raw", producerRole: "developer",
        producerModel: "deepseek-v4-flash", sourceRefs: ["task:t-p05-raw"],
      });
      await expect(
        store.write({
          id: `n29-p05-raw-${kind}`, kind, anchors: ["n29-p05"],
          content, status: "official", meta: { provenance },
        } as any),
      ).rejects.toThrow(/official/);
      expect(await store.get(`n29-p05-raw-${kind}`)).toBeUndefined();
      // force（系统文档通道）不是 knowledge official authority
      await expect(
        store.write({
          id: `n29-p05-raw-force-${kind}`, kind, anchors: ["n29-p05"],
          content, status: "official", meta: { provenance },
        } as any, { force: true }),
      ).rejects.toThrow(/official/);
      expect(await store.get(`n29-p05-raw-force-${kind}`)).toBeUndefined();
      // draft → official 的 update 直写同样被拒
      await store.write({
        id: `n29-p05-upd-${kind}`, kind, anchors: ["n29-p05"],
        content, status: "draft", meta: { provenance },
      } as any);
      await expect(store.update(`n29-p05-upd-${kind}`, { status: "official" })).rejects.toThrow(/official/);
      expect((await store.get(`n29-p05-upd-${kind}`))?.status).toBe("draft");
    }
  });

  it("N29 P0-5：capability facade（withMemoryTenant）不再公开 promoteOfficial", async () => {
    const facade = withMemoryTenant(store, "tenant-p05");
    expect((facade as unknown as Record<string, unknown>)["promoteOfficial"]).toBeUndefined();
    // 只读/草稿面仍然可用（facade 不是被整体关闭）
    expect(typeof (facade as unknown as Record<string, unknown>)["write"]).toBe("function");
    expect(typeof (facade as unknown as Record<string, unknown>)["get"]).toBe("function");
    // facade 写 official 领域知识仍然被拒（authority 被剥离）
    const provenance = buildKnowledgeProvenance({
      content: "facade", sourceTaskId: "t-facade", producerRole: "developer",
      producerModel: "deepseek-v4-flash", sourceRefs: ["task:t-facade"],
    });
    await expect(
      facade.write({
        id: "n29-p05-facade", kind: "domain-fact", anchors: ["n29-p05"],
        content: "facade", status: "official", meta: { provenance },
      } as any, { knowledgeOfficialAuthority: "seed-migration" } as any),
    ).rejects.toThrow(/official/);
    expect(await store.get("n29-p05-facade", { tenantId: "tenant-p05" })).toBeUndefined();
  });

  it("N29 P0-5：内部推理知识写 official 必须显式 origin=internal + 内部 authority", async () => {
    const content = "internal reasoning insight";
    const provenance = buildKnowledgeProvenance({
      content, sourceTaskId: "optimizer-suggestion:s-1", producerRole: "optimizer-loop",
      producerModel: "optimizer-loop", sourceRefs: ["optimizer-suggestion:s-1"],
    });
    // ① 有 authority 但没有显式 origin=internal → 拒绝（不得以"隐式内部"表示可信）
    await expect(
      store.write({
        id: "n29-p05-internal-no-origin", kind: "task-insight", anchors: ["n29-p05"],
        content, status: "official", meta: { provenance },
      } as any, { knowledgeOfficialAuthority: "internal-reasoning" } as any),
    ).rejects.toThrow(/origin/);
    expect(await store.get("n29-p05-internal-no-origin")).toBeUndefined();

    // ② origin=internal + 内部 authority + 有效 provenance → 允许（显式内部来源合同）
    await store.write({
      id: "n29-p05-internal-ok", kind: "task-insight", anchors: ["n29-p05"],
      content, status: "official", meta: { provenance, origin: "internal" },
    } as any, { knowledgeOfficialAuthority: "internal-reasoning" } as any);
    expect((await store.get("n29-p05-internal-ok"))?.status).toBe("official");

    // ③ origin=internal 但没有 authority → 仍然拒绝（origin 不是 authority）
    await expect(
      store.write({
        id: "n29-p05-internal-no-auth", kind: "task-insight", anchors: ["n29-p05"],
        content, status: "official", meta: { provenance, origin: "internal" },
      } as any),
    ).rejects.toThrow(/official/);
    expect(await store.get("n29-p05-internal-no-auth")).toBeUndefined();
  });

  it("K1b：真实 PG 链路 draft domain-fact（meta.provenance）→ plan verdict rows → promote → official", async () => {
    const content = "The Earth orbits the Sun.";
    const provenance = buildKnowledgeProvenance({
      content,
      sourceTaskId: "task-1",
      producerRole: "developer",
      producerModel: "deepseek-v4-flash",
      sourceRefs: ["task:task-1"],
    });
    // N29 再验收 P0-5：legacy 空 digest/空 evidence 兼容路径已删除——内部 candidate 也必须显式声明来源绑定。
    const chainEvidence = [{ sourceId: "task:task-1", locator: "task-output#1" }];
    await store.write({
      id: "k1b-chain", kind: "domain-fact", anchors: ["science"],
      content, status: "draft", meta: { provenance, evidence: chainEvidence, verdicts: [] },
    } as any);

    const repo = createPgKnowledgeVerificationRepo(pool);
    await pool.query(
      `INSERT INTO knowledge_verification_plans
         (id, tenant_id, candidate_id, candidate_revision, candidate_hash, required_domains, checks, source_bindings_digest, status)
       VALUES ('plan-k1b-chain', $1, 'k1b-chain', 1, $2, '["mathematics"]'::jsonb, $3::jsonb, $4, 'open')`,
      [
        DEFAULT_TENANT_ID,
        computeCandidateHash({ content, domains: ["mathematics"], evidence: chainEvidence, effect: null }),
        JSON.stringify([
          { checkId: "domain-1", kind: "domain", domainId: "mathematics", quorum: 1, eligiblePrincipals: ["tenant:tenant-a:platform-admin"], separationFrom: ["producer", "other-verifier"] },
          { checkId: "adv-1", kind: "adversarial", quorum: 1, eligiblePrincipals: ["worker:controller:adversarial"], separationFrom: ["producer", "other-verifier"] },
        ]),
        sourceBindingsDigestOf(chainEvidence),
      ],
    );

    const authDomain = { principalId: "tenant:tenant-a:platform-admin", executionId: "task-d", roleId: "platform-admin" };
    const authAdv = { principalId: "worker:controller:adversarial", executionId: "task-a", roleId: "controller:adversarial" };
    expect((await recordKnowledgeVerdict(store, repo, "plan-k1b-chain", "domain-1", 1, {
      kind: "domain", verdict: "pass", reviewerRole: "domain:expert",
      note: "domain evidence verified", at: 1, domainId: "mathematics",
    }, authDomain, { tenantId: DEFAULT_TENANT_ID })).ok).toBe(true);
    expect((await recordKnowledgeVerdict(store, repo, "plan-k1b-chain", "adv-1", 1, {
      kind: "adversarial", verdict: "pass", reviewerRole: "controller:adversarial",
      note: "no shortcut / pitfall covered", at: 2,
    }, authAdv, { tenantId: DEFAULT_TENANT_ID })).ok).toBe(true);

    const promoted = await promoteKnowledgeEntry(
      store, repo, "k1b-chain", "plan-k1b-chain", 1,
      { principalId: "worker:memory-keeper", executionId: "task-mk", roleId: "memory-keeper" },
      { tenantId: DEFAULT_TENANT_ID },
    );
    expect(promoted).toEqual({ ok: true, id: "k1b-chain" });

    const got = await store.get("k1b-chain");
    expect(got?.status).toBe("official");
    expect(got?.meta.provenance).toEqual(provenance);
    expect(got?.meta.promotion).toMatchObject({ promotedBy: "memory-keeper", planId: "plan-k1b-chain" });

    // R3：verdict 落新表不 append meta.verdicts、不递增 candidate version；
    // promotion 事务只写晋升前旧 revision 一次。
    const history = await store.revisionHistory("k1b-chain");
    expect(history.map((h) => h.revision)).toEqual([1]);
    expect(history[0].meta?.verdicts).toHaveLength(0);
    expect(history[0].status).toBe("draft");
    expect(history[0].reason).toBe("knowledge-promotion");
  });

  it("F2：复合 PK 后同 id 跨 tenant 可并存（write/get/retrieve 互不可见）", async () => {
    await store.write({ id: "f2-dup", kind: "fact", anchors: ["f2-dup"], content: "default-tenant", tenantId: DEFAULT_TENANT_ID, meta: {} } as any);
    await store.write({ id: "f2-dup", kind: "fact", anchors: ["f2-dup"], content: "tenant-a", tenantId: "tenant-a", meta: {} } as any);

    expect((await store.get("f2-dup", { tenantId: DEFAULT_TENANT_ID }))?.content).toBe("default-tenant");
    expect((await store.get("f2-dup", { tenantId: "tenant-a" }))?.content).toBe("tenant-a");

    const defaults = await store.retrieve({ anchors: ["f2-dup"], tenantId: DEFAULT_TENANT_ID });
    expect(defaults.map((e) => e.content)).toEqual(["default-tenant"]);
    const others = await store.retrieve({ anchors: ["f2-dup"], tenantId: "tenant-a" });
    expect(others.map((e) => e.content)).toEqual(["tenant-a"]);
  });

  it("F2：复合 PK 后并发写同 id 不同 tenant 不冲突", async () => {
    await Promise.all([
      store.write({ id: "f2-conc", kind: "fact", anchors: ["f2-conc"], content: "t1", tenantId: "tenant-1", meta: {} } as any),
      store.write({ id: "f2-conc", kind: "fact", anchors: ["f2-conc"], content: "t2", tenantId: "tenant-2", meta: {} } as any),
      store.write({ id: "f2-conc", kind: "fact", anchors: ["f2-conc"], content: "t3", tenantId: "tenant-3", meta: {} } as any),
    ]);
    expect((await store.get("f2-conc", { tenantId: "tenant-1" }))?.content).toBe("t1");
    expect((await store.get("f2-conc", { tenantId: "tenant-2" }))?.content).toBe("t2");
    expect((await store.get("f2-conc", { tenantId: "tenant-3" }))?.content).toBe("t3");
  });

  it("F2：incrementAggregate 同 id 不同 tenant 各自聚合（复合冲突目标）", async () => {
    await store.incrementAggregate("f2-agg", "agg", ["f2-agg"], { n: 1 }, {}, { tenantId: "tenant-a" });
    await store.incrementAggregate("f2-agg", "agg", ["f2-agg"], { n: 10 }, {}, { tenantId: "tenant-b" });
    await store.incrementAggregate("f2-agg", "agg", ["f2-agg"], { n: 2 }, {}, { tenantId: "tenant-a" });

    expect(JSON.parse((await store.get("f2-agg", { tenantId: "tenant-a" }))?.content ?? "{}").n).toBe(3);
    expect(JSON.parse((await store.get("f2-agg", { tenantId: "tenant-b" }))?.content ?? "{}").n).toBe(10);
  });

  it("F2：复合 PK 迁移后旧行仍可读（迁移前写入的 default 行）", async () => {
    // beforeAll 建表后已有 e1 等旧行（id pkey 时代写入）——复合 PK 迁移后必须仍可读。
    const old = await store.get("e1");
    expect(old?.content).toBe("x");
  });

  it("F2：requireTenant=true 缺失 tenant 抛指定文案（write/get/update/retrieve/listIds/bumpHitCount/incrementAggregate/revisionHistory/restoreRevision）", async () => {
    const strict = new PgMemoryStore(pool, { requireTenant: true });
    const fail = "memory: tenantId required（TenantScope fail-closed）";

    await expect(strict.write({ id: "f2-strict", kind: "fact", anchors: ["f2-strict"], content: "x", meta: {} } as any)).rejects.toThrow(fail);
    await expect(strict.get("f2-strict")).rejects.toThrow(fail);
    await expect(strict.update("f2-strict", { content: "y" })).rejects.toThrow(fail);
    await expect(strict.retrieve({ anchors: ["f2-strict"] })).rejects.toThrow(fail);
    await expect(strict.listIds()).rejects.toThrow(fail);
    await expect(strict.bumpHitCount("f2-strict")).rejects.toThrow(fail);
    await expect(strict.incrementAggregate("f2-strict", "agg", ["f2-strict"], { n: 1 }, {})).rejects.toThrow(fail);
    await expect(strict.revisionHistory("f2-strict")).rejects.toThrow(fail);
    await expect(strict.restoreRevision("f2-strict", 1)).rejects.toThrow(fail);

    // 显式 tenant 后可正常写读。
    await strict.write({ id: "f2-strict", tenantId: "tenant-a", kind: "fact", anchors: ["f2-strict"], content: "x", meta: {} } as any);
    expect((await strict.get("f2-strict", { tenantId: "tenant-a" }))?.content).toBe("x");
  });
});

// provenanceFromMeta 是纯函数——suite 外独立 describe（不需要 docker/连接）
describe("provenanceFromMeta（AB-02 canonical 读取）", () => {
  it("读取 meta.provenance 六字段", () => {
    const provenance = buildKnowledgeProvenance({
      content: "x", sourceTaskId: "t1", producerRole: "developer",
      producerModel: "deepseek-v4-flash", sourceRefs: ["task:t1"],
    });
    expect(provenanceFromMeta({ provenance })).toEqual(provenance);
  });

  it("meta 缺失/非对象/provenance 缺失/字段不全 → undefined", () => {
    expect(provenanceFromMeta(undefined)).toBeUndefined();
    expect(provenanceFromMeta(null)).toBeUndefined();
    expect(provenanceFromMeta("x")).toBeUndefined();
    expect(provenanceFromMeta({})).toBeUndefined();
    expect(provenanceFromMeta({ provenance: { sourceTaskId: "t1" } })).toBeUndefined();
  });
});

// 键名校验在 SQL 之前（不需要 docker/连接）——suite 外独立 describe
describe("incrementAggregate 键名校验（2026-08-12 审计 CRITICAL-1 修复）", () => {
  it("非法键抛错（SQL 注入防护——引号/分号/括号拒收）", async () => {
    const store = new PgMemoryStore({ query: async () => { throw new Error("不应触达 pool"); } } as never);
    await expect(store.incrementAggregate("a", "k", [], { "x' OR 1=1--": 1 }, {})).rejects.toThrow(/非法增量键/);
    await expect(store.incrementAggregate("a", "k", [], { "k; DROP TABLE x": 1 }, {})).rejects.toThrow(/非法增量键/);
  });
  it("合法键通过校验（抵达 pool 层——query 被调用）", async () => {
    let called = false;
    const store = new PgMemoryStore({ query: async () => { called = true; } } as never);
    await store.incrementAggregate("a", "k", [], { taskCount: 1, sumSteps: 2 }, {});
    expect(called).toBe(true);
  });
});

// B4 Phase 3：skill 不可变——store 层 update 必须显式 force（SQL 之前拒绝）
describe("skill 不可变（B4 Phase 3）", () => {
  it("skill: 条目隐式 update 拒绝；force 抵达 pool 层", async () => {
    const store = new PgMemoryStore({ query: async () => ({ rows: [], rowCount: 0 }) } as never);
    await expect(store.update("skill:x", { content: "篡改" })).rejects.toThrow(/不可变/);
    let called = false;
    const oldRow = {
      id: "skill:x",
      tenant_id: "default",
      content: "old",
      status: "official",
      anchors: ["skill"],
      meta: {},
      version: 1,
    };
    const store2 = new PgMemoryStore({
      connect: async () => ({
        query: async (sql: string) => {
          called = true;
          if (sql.includes("FOR UPDATE")) return { rows: [oldRow], rowCount: 1 };
          if (sql.startsWith("UPDATE")) return { rows: [{ id: "skill:x" }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      }),
    } as never);
    await store2.update("skill:x", { content: "合法维护" }, { force: true });
    expect(called).toBe(true);
  });
});
