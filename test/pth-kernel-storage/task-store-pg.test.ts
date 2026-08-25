import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool } from "@away_from/pth-kernel-storage";
import { applySchema } from "@away_from/pth-kernel-storage";
import { PgTaskStore } from "@away_from/pth-kernel-storage";
import { checkTaskRouting, routeTaskRole } from "@away_from/pth-kernel-execution";
import { installDefaultRoles } from "../helpers";

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
    // 2026-08-13 审计 P2：路由策略注入（存储层纯化——publish 校验/分配由装配层传入）
    installDefaultRoles();
    store = new PgTaskStore(pool, { validate: checkTaskRouting, assign: routeTaskRole });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("publish creates a pending task", async () => {
    const t = await store.publish({ title: "t1", text: "do x", createdBy: "me", tags: ["code"] });
    expect(t.status).toBe("pending");
    expect(t.id).toBeTruthy();
  });

  it("N33 P0-4：tenant-scoped 幂等键 exact 重放收敛到首次任务；不同正文 conflict", async () => {
    const first = await store.publish({
      title: "idem", text: "first", createdBy: "me", tags: ["code"], tenantId: "tenant-a", idempotencyKey: "idem-key-1",
    });
    const replay = await store.publish({
      title: "idem", text: "first", createdBy: "me", tags: ["code"], tenantId: "tenant-a", idempotencyKey: "idem-key-1",
    });
    expect(replay.id).toBe(first.id);
    await expect(store.publish({
      title: "idem", text: "retry-after-lost-response", createdBy: "me", tags: ["code"], tenantId: "tenant-a", idempotencyKey: "idem-key-1",
    })).rejects.toThrow(/idempotencyKey conflict/);
    const otherTenant = await store.publish({
      title: "idem", text: "other tenant", createdBy: "me", tags: ["code"], tenantId: "tenant-b", idempotencyKey: "idem-key-1",
    });
    expect(otherTenant.id).not.toBe(first.id);
  });

  it("P1-1：存量行可读写，lease 列默认安全并可回读", async () => {
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, title, text, created_by, status)
       VALUES ('legacy-task','tenant-a','legacy','legacy text','me','pending')`,
    );
    const legacy = await store.getById("legacy-task");
    expect(legacy?.leaseGeneration).toBe(0);
    expect(legacy?.leaseId).toBeNull();

    const leaseId = "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6";
    await pool.query(
      `UPDATE tasks SET lease_id = $1, lease_generation = $2, lease_expires_at = now() WHERE id = 'legacy-task'`,
      [leaseId, 1],
    );
    const leased = await store.getById("legacy-task");
    expect(leased?.leaseId).toBe(leaseId);
    expect(leased?.leaseGeneration).toBe(1);
    expect(leased?.leaseExpiresAt).toBeInstanceOf(Date);

    // 旧诊断字段保留：claim/reject/submit 语义不回退
    await store.claimTopN("dev-worker", ["legacy-task"]);
    expect((await store.getById("legacy-task"))?.claimed_by).toBe("dev-worker");
  });

  it("candidates returns matching tasks by tags", async () => {
    const t = await store.publish({ title: "t2", text: "do y", createdBy: "me", tags: ["analysis"] });
    const cands = await store.candidates("analyst");
    expect(cands.some((c) => c.id === t.id)).toBe(true);
  });

  it("claimTopN claims exclusively", async () => {
    const t = await store.publish({ title: "t3", text: "do z", createdBy: "me", tags: ["code"] });
    const claimed = await store.claimTopN("dev-worker", [t.id]);
    expect(claimed.length).toBe(1);
    expect(claimed[0].claimed_by).toBe("dev-worker");
    // 二次认领失败（已 claimed）
    const again = await store.claimTopN("other-worker", [t.id]);
    expect(again.length).toBe(0);
  });

  it("concurrent claim is exclusive (SKIP LOCKED)", async () => {
    const t = await store.publish({ title: "t4", text: "race", createdBy: "me", tags: ["code"] });
    const [r1, r2] = await Promise.all([
      store.claimTopN("w1", [t.id]),
      store.claimTopN("w2", [t.id]),
    ]);
    expect(r1.length + r2.length).toBe(1); // 只有一个认领成功
  });

  it("reject records reason and exclude", async () => {
    const t = await store.publish({ title: "t5", text: "rej", createdBy: "me", tags: ["code"] });
    await store.reject("w1", t.id, "cannot complete");
    const row = await pool.query("SELECT rejects, status FROM tasks WHERE id = $1", [t.id]);
    expect(row.rows[0].rejects).toEqual([{ agentId: "w1", reason: "cannot complete", at: expect.any(Number) }]);
  });

  it("submit marks completed with outputRef", async () => {
    const t = await store.publish({ title: "t6", text: "sub", createdBy: "me", tags: ["code"] });
    await store.claimTopN("w1", [t.id]);
    await store.submit("w1", t.id, { ref: "transcript-1" });
    const row = await pool.query("SELECT status, payload FROM tasks WHERE id = $1", [t.id]);
    expect(row.rows[0].status).toBe("completed");
    // W8 P0：payload.result = JSON-safe 编码结果；outputRef 兼容面保留
    expect(row.rows[0].payload.result).toEqual({ ref: "transcript-1" });
    expect(row.rows[0].payload.outputRef).toEqual({ ref: { ref: "transcript-1" } });
  });

  it("H5: submit 返回 rowCount——非本人认领（已被回收重领）→ 0 行（双执行信号）", async () => {
    const t = await store.publish({ title: "t6b", text: "sub-race", createdBy: "me", tags: ["code"] });
    await store.claimTopN("w1", [t.id]);
    // 模拟：claim 被回收后另一 worker 重领
    await store.recoverStaleClaims(0.0001);
    await store.claimTopN("w2", [t.id]);
    // 原 worker w1 提交 → 0 行（claim 已不属于 w1）
    const n = await store.submit("w1", t.id, { ref: "stale" });
    expect(n).toBe(0);
    const row = await pool.query("SELECT status, claimed_by FROM tasks WHERE id = $1", [t.id]);
    expect(row.rows[0].status).toBe("claimed"); // w2 的认领不受影响
    expect(row.rows[0].claimed_by).toBe("w2");
  });

  it("H5: reject 返回 rowCount——非本人认领 → 0 行", async () => {
    const t = await store.publish({ title: "t6c", text: "rej-race", createdBy: "me", tags: ["code"] });
    await store.claimTopN("w1", [t.id]);
    const n = await store.reject("w2", t.id, "not mine");
    expect(n).toBe(0);
    const row = await pool.query("SELECT claimed_by FROM tasks WHERE id = $1", [t.id]);
    expect(row.rows[0].claimed_by).toBe("w1"); // w1 认领保持
  });

  it("countPending counts only pending tasks (relative to current state)", async () => {
    // 同 suite 前序测试在共享 DB 累积了各种状态的任务，故用相对断言（跨 spec 扩展：Task 5 负载统计依赖）。
    const before = await store.countPending();
    const t = await store.publish({ title: "t7", text: "count", createdBy: "me", tags: ["code"] });
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
    const t = await store.publish({ title: "broken", text: "syntax error(", createdBy: "me", tags: ["code"] });
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
    const t2 = await store.publish({ title: "ok", text: "fine", createdBy: "me", tags: ["code"] });
    await store.claimTopN("w1", [t2.id]);
    await store.reject("w1", t2.id, "assessed-as-unfit");
    row = (await pool.query("SELECT status FROM tasks WHERE id = $1", [t2.id])).rows[0];
    expect(row.status).toBe("pending");
  });
  it("正交化：publish 路由 assigned_role，candidates 只返回自己队列", async () => {
    // 语义路由：tags 精确匹配 developer
    const dev = await store.publish({ title: "code task", text: "fn(){}", createdBy: "me", tags: ["code"] });
    expect(dev.assigned_role).toBe("developer");
    // 无主任务：v2 严格模式——无角色标签拒绝（hash 分片兜底已废止）
    await expect(store.publish({ title: "no tag", text: "x", createdBy: "me" })).rejects.toThrow(/缺少角色标签/);
    // candidates(developer) 看到 dev 任务
    const devCands = await store.candidates("developer");
    expect(devCands.some((c) => c.id === dev.id)).toBe(true);
    // candidates(analyst) 看不到 dev 任务
    const anaCands = await store.candidates("analyst");
    expect(anaCands.some((c) => c.id === dev.id)).toBe(false);
    // flow 显式 role 的任务确定性归属
    const flow = await store.publish({
      title: "flow", text: "x", createdBy: "me",
      payload: { flow: { stages: [{ task: { role: "scout" } }] } },
    });
    expect(flow.assigned_role).toBe("scout");
    // candidates(scout) 看到 flow 任务
    const scoutCands = await store.candidates("scout");
    expect(scoutCands.some((c) => c.id === flow.id)).toBe(true);
    // candidates(analyst) 看不到 flow 任务
    const anaCands2 = await store.candidates("analyst");
    expect(anaCands2.some((c) => c.id === flow.id)).toBe(false);
  });

  it("W8 P0：entry delivery 盖章——外部入口 path/lineageId；内部发布不盖章", async () => {
    const entry = await store.publish({
      title: "entry", text: "x", createdBy: "me", tags: ["code"],
      payload: { delivery: { path: ["forged"], lineageId: "forged" } },
      deliveryMode: "entry",
    });
    expect((entry.payload as { delivery?: unknown }).delivery).toEqual({
      path: ["developer"],
      lineageId: entry.id,
    });

    const internal = await store.publish({ title: "internal", text: "x", createdBy: "me", tags: ["code"] });
    expect((internal.payload as { delivery?: unknown }).delivery).toBeUndefined();
  });
});
