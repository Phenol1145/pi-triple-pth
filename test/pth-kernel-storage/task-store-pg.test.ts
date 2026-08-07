import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool } from "../../src/pth/kernel/storage/pg";
import { applySchema } from "../../src/pth/kernel/storage/schema";
import { PgTaskStore } from "../../src/pth/kernel/storage/task-store-pg";

// --- Docker 可用性守卫（Global Constraints：无 docker 环境必须 SKIP 而非 FAIL）---
// 模式同 Task 1（test/pth-kernel-storage/pg.test.ts）与 Task 2（schema.test.ts）：
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

suite("task store pg", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let store: PgTaskStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    store = new PgTaskStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("publish creates a pending task", async () => {
    const t = await store.publish({ title: "t1", text: "do x", createdBy: "me", tags: ["dev"] });
    expect(t.status).toBe("pending");
    expect(t.id).toBeTruthy();
  });

  it("candidates returns matching tasks by tags", async () => {
    const t = await store.publish({ title: "t2", text: "do y", createdBy: "me", tags: ["analysis"] });
    const cands = await store.candidates("analyst");
    expect(cands.some((c) => c.id === t.id)).toBe(true);
  });

  it("claimTopN claims exclusively", async () => {
    const t = await store.publish({ title: "t3", text: "do z", createdBy: "me", tags: ["dev"] });
    const claimed = await store.claimTopN("dev-worker", [t.id]);
    expect(claimed.length).toBe(1);
    expect(claimed[0].claimed_by).toBe("dev-worker");
    // 二次认领失败（已 claimed）
    const again = await store.claimTopN("other-worker", [t.id]);
    expect(again.length).toBe(0);
  });

  it("concurrent claim is exclusive (SKIP LOCKED)", async () => {
    const t = await store.publish({ title: "t4", text: "race", createdBy: "me", tags: ["dev"] });
    const [r1, r2] = await Promise.all([
      store.claimTopN("w1", [t.id]),
      store.claimTopN("w2", [t.id]),
    ]);
    expect(r1.length + r2.length).toBe(1); // 只有一个认领成功
  });

  it("reject records reason and exclude", async () => {
    const t = await store.publish({ title: "t5", text: "rej", createdBy: "me", tags: ["dev"] });
    await store.reject("w1", t.id, "cannot complete");
    const row = await pool.query("SELECT rejects, status FROM tasks WHERE id = $1", [t.id]);
    expect(row.rows[0].rejects).toEqual([{ agentId: "w1", reason: "cannot complete", at: expect.any(Number) }]);
  });

  it("submit marks completed with outputRef", async () => {
    const t = await store.publish({ title: "t6", text: "sub", createdBy: "me", tags: ["dev"] });
    await store.claimTopN("w1", [t.id]);
    await store.submit("w1", t.id, { ref: "transcript-1" });
    const row = await pool.query("SELECT status FROM tasks WHERE id = $1", [t.id]);
    expect(row.rows[0].status).toBe("completed");
  });
});
