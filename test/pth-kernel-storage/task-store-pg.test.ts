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

  it("countPending counts only pending tasks (relative to current state)", async () => {
    // 同 suite 前序测试在共享 DB 累积了各种状态的任务，故用相对断言（跨 spec 扩展：Task 5 负载统计依赖）。
    const before = await store.countPending();
    const t = await store.publish({ title: "t7", text: "count", createdBy: "me", tags: ["dev"] });
    expect(await store.countPending()).toBe(before + 1);
    await store.claimTopN("w1", [t.id]);
    expect(await store.countPending()).toBe(before); // claimed 不再计入
    await store.reject("w1", t.id, "back to pending");
    expect(await store.countPending()).toBe(before + 1); // reject 回 pending 重新计入
    await store.claimTopN("w1", [t.id]);
    await store.submit("w1", t.id, { ref: "count-test" });
    expect(await store.countPending()).toBe(before); // completed 不计入
  });
  it("terminal reject 终态化（不回池）——坏任务防无限 claim 循环", async () => {
    const t = await store.publish({ title: "broken", text: "syntax error(", createdBy: "me", tags: ["dev"] });
    // 第一次 claim → 执行失败 → terminal reject
    await store.claimTopN("w1", [t.id]);
    await store.reject("w1", t.id, "execution-failed: syntax", { terminal: true });
    let row = (await pool.query("SELECT status, rejects FROM tasks WHERE id = $1", [t.id])).rows[0];
    expect(row.status).toBe("rejected");
    expect(row.rejects).toHaveLength(1);
    // 终态后 candidates 不再返回
    const cands = await store.candidates({ limit: 10 });
    expect(cands.some((c: { id: string }) => c.id === t.id)).toBe(false);
    // 普通 reject 仍回池（回归保护）
    const t2 = await store.publish({ title: "ok", text: "fine", createdBy: "me", tags: ["dev"] });
    await store.claimTopN("w1", [t2.id]);
    await store.reject("w1", t2.id, "assessed-as-unfit");
    row = (await pool.query("SELECT status FROM tasks WHERE id = $1", [t2.id])).rows[0];
    expect(row.status).toBe("pending");
  });
  it("正交化：publish 路由 assigned_role，candidates 只返回自己队列", async () => {
    // 语义路由：tags 匹配 developer
    const dev = await store.publish({ title: "code task", text: "fn(){}", createdBy: "me", tags: ["code"] });
    expect(dev.assigned_role).toBe("developer");
    // 无主任务：hash 分片（确定性）
    const noTag = await store.publish({ title: "no tag", text: "x", createdBy: "me" });
    expect(noTag.assigned_role).toBeTruthy();
    // candidates(developer) 看到 dev 任务
    const devCands = await store.candidates("developer");
    expect(devCands.some((c) => c.id === dev.id)).toBe(true);
    // candidates(analyst) 看不到 dev 任务
    const anaCands = await store.candidates("analyst");
    expect(anaCands.some((c) => c.id === dev.id)).toBe(false);
    // 无主任务只出现在其分片角色队列
    const owner = noTag.assigned_role!;
    const ownerCands = await store.candidates(owner);
    expect(ownerCands.some((c) => c.id === noTag.id)).toBe(true);
    const other = owner === "analyst" ? "planner" : "analyst";
    const otherCands = await store.candidates(other);
    expect(otherCands.some((c) => c.id === noTag.id)).toBe(false);
  });
});
