import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { Pool } from "pg";
import { MEMORY_SCHEMA_SQL, PgMemoryStore, runReadOnlyQuery } from "@away_from/pth-memory";

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
    await pool.query(MEMORY_SCHEMA_SQL);
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
    // 对齐 FS write 路径②：entry.meta.version === existing.meta.version && content 相同 → 重落库不递增版本
    await store.write({ id: "e6", kind: "fact", anchors: ["theta"], content: "idem", meta: { version: 1, sourceTraces: ["t1"] } } as any);
    await store.write({ id: "e6", kind: "fact", anchors: ["theta"], content: "idem", meta: { version: 1, sourceTraces: ["t1", "t2"] } } as any);
    const got = await store.get("e6");
    expect(got?.content).toBe("idem");
    expect(got?.meta?.version).toBe(1); // 幂等重落库不递增
    expect(got?.meta?.sourceTraces).toEqual(["t1", "t2"]); // 调用方 meta 整条写回
  });

  it("write conflict merges caller meta (FS persist 整条写回)", async () => {
    await store.write({ id: "e7", kind: "fact", anchors: ["zeta"], content: "c1", meta: { sourceTraces: ["t1"] } } as any);
    await store.write({ id: "e7", kind: "fact", anchors: ["zeta"], content: "c2", meta: { sourceTraces: ["t1", "t2"] } } as any);
    const got = await store.get("e7");
    expect(got?.content).toBe("c2");
    expect(got?.meta?.version).toBe(2);                    // 新状态 → version+1
    expect(got?.meta?.sourceTraces).toEqual(["t1", "t2"]); // 调用方 meta 保留（旧+新）
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
    const store2 = new PgMemoryStore({ query: async () => { called = true; return { rows: [{ id: "x" }], rowCount: 1 }; } } as never);
    await store2.update("skill:x", { content: "合法维护" }, { force: true });
    expect(called).toBe(true);
  });
});
