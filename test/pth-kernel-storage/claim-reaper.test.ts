import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool } from "@away_from/pth-kernel-storage";
import { applySchema } from "@away_from/pth-kernel-storage";
import { createDataWorld } from "@away_from/pth-kernel-storage";

/**
 * claim 超时回收（batch 崩溃/重启时 claimed 任务不回池的缺口）。
 * 语义：claimed_at 超过 timeoutMs 的僵尸认领 → 回滚 pending（清 claimed_by/claimed_at）。
 */

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

suite("claim 超时回收（recoverStaleClaims）", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("僵尸认领（claimed_at 超时）→ 回收回 pending + 清 claimed_by", async () => {
    const dw = createDataWorld(pool);
    const t = await dw.tasks.publish({ title: "stale-1", text: "x", createdBy: "me", tags: ["code"] });
    await dw.tasks.claimTopN("dead-worker", [t.id]);
    // 模拟 batch 崩溃：把 claimed_at 改到 1 小时前
    await pool.query("UPDATE tasks SET claimed_at = now() - interval '1 hour' WHERE id = $1", [t.id]);

    const recovered = await dw.tasks.recoverStaleClaims(600_000);
    expect(recovered).toBe(1);
    const row = (await pool.query("SELECT status, claimed_by, claimed_at FROM tasks WHERE id = $1", [t.id])).rows[0];
    expect(row.status).toBe("pending");
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();
  });

  it("未超时的认领不回收", async () => {
    const dw = createDataWorld(pool);
    const t = await dw.tasks.publish({ title: "fresh-1", text: "x", createdBy: "me", tags: ["code"] });
    await dw.tasks.claimTopN("live-worker", [t.id]);
    const recovered = await dw.tasks.recoverStaleClaims(600_000);
    expect(recovered).toBe(0);
    const row = (await pool.query("SELECT status, claimed_by FROM tasks WHERE id = $1", [t.id])).rows[0];
    expect(row.status).toBe("claimed");
    expect(row.claimed_by).toBe("live-worker");
  });

  it("回收后的任务可再次认领（claims_count 不重置——坏任务防循环保留）", async () => {
    const dw = createDataWorld(pool);
    const t = await dw.tasks.publish({ title: "reclaim-1", text: "x", createdBy: "me", tags: ["code"] });
    await dw.tasks.claimTopN("dead-worker", [t.id]);
    const before = (await pool.query("SELECT claims_count FROM tasks WHERE id = $1", [t.id])).rows[0].claims_count;
    await pool.query("UPDATE tasks SET claimed_at = now() - interval '1 hour' WHERE id = $1", [t.id]);
    await dw.tasks.recoverStaleClaims(600_000);
    const claimed = await dw.tasks.claimTopN("new-worker", [t.id]);
    expect(claimed.length).toBe(1);
    const after = (await pool.query("SELECT claims_count FROM tasks WHERE id = $1", [t.id])).rows[0].claims_count;
    expect(Number(after)).toBe(Number(before) + 1); // 二次认领计数递增
  });

  it("completed/rejected 任务不受回收影响", async () => {
    const dw = createDataWorld(pool);
    const t = await dw.tasks.publish({ title: "done-1", text: "x", createdBy: "me", tags: ["code"] });
    await dw.tasks.claimTopN("w", [t.id]);
    await pool.query("UPDATE tasks SET claimed_at = now() - interval '1 hour' WHERE id = $1", [t.id]);
    await dw.tasks.submit("w", t.id, { ref: "r" }); // claimed → completed
    const r = await dw.tasks.recoverStaleClaims(600_000);
    expect(r).toBe(0);
    const row = (await pool.query("SELECT status FROM tasks WHERE id = $1", [t.id])).rows[0];
    expect(row.status).toBe("completed");
  });
});
