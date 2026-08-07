import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool } from "../../src/pth/kernel/storage/pg";
import { applySchema } from "../../src/pth/kernel/storage/schema";
import { PgMemoryStore } from "../../src/pth/kernel/storage/memory-store-pg";

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
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let store: PgMemoryStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
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
});
