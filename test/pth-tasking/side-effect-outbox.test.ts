import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { Pool } from "pg";
import {
  PgSideEffectOutbox,
  createSideEffectDrainer,
  type SideEffectOutboxPort,
} from "../../src/pth/tasking/side-effect-outbox.js";
import { createPgTaskRepository } from "../../src/pth/tasking/adapters/pg-task-repository.js";
import type { TaskOutcome } from "../../src/pth/contracts/index.js";
import { SCHEMA_SQL } from "../../src/pth/kernel/storage/schema.js";

// --- Docker 可用性守卫（无 docker 环境 SKIP 而非 FAIL——真实 PG 探针）---
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

suite("PgSideEffectOutbox（真实 PG）", () => {
  let container: PostgreSqlContainer;
  let pool: Pool;
  let poolB: Pool;
  let outbox: PgSideEffectOutbox;
  let outboxB: PgSideEffectOutbox;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    poolB = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(SCHEMA_SQL);
    outbox = new PgSideEffectOutbox(pool);
    outboxB = new PgSideEffectOutbox(poolB);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([pool.end(), poolB.end()]);
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE side_effect_outbox RESTART IDENTITY CASCADE");
  });

  async function enqueue(key: string, kind = "refine", payload: unknown = { n: 1 }): Promise<void> {
    await outbox.enqueue({ key, tenantId: "tenant-a", kind, payload });
  }

  it("claim atomically marks pending as processing with token and lease", async () => {
    await enqueue("k1");
    const [row] = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    expect(row).toBeDefined();
    expect(row!.status).toBe("processing");
    expect(row!.processingToken).toBeTruthy();
    expect(row!.owner).toBe("drainer-a");
    expect(row!.attempts).toBe(1);
    expect(row!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(row!.availableAt).toBeInstanceOf(Date);

    // 已被 claim 的行不能再被第二个 drainer 领取
    const again = await outboxB.claimPending(1, { owner: "drainer-b", leaseMs: 60_000 });
    expect(again).toHaveLength(0);
  });

  it("two concurrent drainers never claim the same row", async () => {
    for (let i = 0; i < 20; i++) await enqueue(`k-${i}`);
    const [a, b] = await Promise.all([
      outbox.claimPending(10, { owner: "drainer-a", leaseMs: 60_000 }),
      outboxB.claimPending(10, { owner: "drainer-b", leaseMs: 60_000 }),
    ]);
    expect(a).toHaveLength(10);
    expect(b).toHaveLength(10);
    const seen = new Set<string>();
    for (const row of [...a, ...b]) {
      expect(seen.has(row.key)).toBe(false);
      seen.add(row.key);
      expect(row.processingToken).toBeTruthy();
      expect(row.status).toBe("processing");
    }
    expect(seen.size).toBe(20);
    // 20 行全部 processing，无 pending 可再领
    const leftover = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    expect(leftover).toHaveLength(0);
  });

  it("complete with wrong token does nothing (CAS conflict)", async () => {
    await enqueue("k1");
    const [row] = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    const wrong = await outbox.complete("k1", "wrong-token");
    expect(wrong).toBe(false);

    const db = await pool.query("SELECT status, processing_token FROM side_effect_outbox WHERE key = $1", ["k1"]);
    expect(db.rows[0].status).toBe("processing");
    expect(db.rows[0].processing_token).toBe(row!.processingToken);

    const ok = await outbox.complete("k1", row!.processingToken!);
    expect(ok).toBe(true);
    const after = await pool.query("SELECT status, done_at FROM side_effect_outbox WHERE key = $1", ["k1"]);
    expect(after.rows[0].status).toBe("done");
    expect(after.rows[0].done_at).not.toBeNull();
  });

  it("stale handler cannot move completed row back to pending", async () => {
    await enqueue("k1");
    const [row] = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    expect(await outbox.complete("k1", row!.processingToken!)).toBe(true);

    const stale = await outbox.markFailed({
      key: "k1",
      token: row!.processingToken!,
      attempts: 1,
      lastError: "stale handler after complete",
    });
    expect(stale).toBe(false);
    const db = await pool.query("SELECT status FROM side_effect_outbox WHERE key = $1", ["k1"]);
    expect(db.rows[0].status).toBe("done");
  });

  it("markFailed with token applies backoff and dead-letter after threshold", async () => {
    await enqueue("k1");
    const [first] = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    const failed1 = await outbox.markFailed({
      key: "k1",
      token: first!.processingToken!,
      attempts: 1,
      lastError: "llm down #1",
      maxAttempts: 3,
      backoffMs: 5_000,
    });
    expect(failed1).toBe(true);
    let db = await pool.query(
      "SELECT status, attempts, last_error, available_at, dead_letter_at FROM side_effect_outbox WHERE key = $1",
      ["k1"],
    );
    expect(db.rows[0].status).toBe("pending");
    expect(Number(db.rows[0].attempts)).toBe(1);
    expect(db.rows[0].last_error).toBe("llm down #1");
    expect(new Date(db.rows[0].available_at).getTime()).toBeGreaterThan(Date.now());

    // backoff 未到：不可领取
    const tooSoon = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    expect(tooSoon).toHaveLength(0);

    // 手动把 available_at 拨回过去，模拟 backoff 到期 → 可重新 claim（attempts+1）
    await pool.query("UPDATE side_effect_outbox SET available_at = now() - interval '1 second' WHERE key = $1", ["k1"]);
    const [second] = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    expect(second!.attempts).toBe(2);
    expect(second!.processingToken).not.toBe(first!.processingToken);

    const failed2 = await outbox.markFailed({
      key: "k1",
      token: second!.processingToken!,
      attempts: 2,
      lastError: "llm down #2",
      maxAttempts: 3,
      backoffMs: 5_000,
    });
    expect(failed2).toBe(true);
    await pool.query("UPDATE side_effect_outbox SET available_at = now() - interval '1 second' WHERE key = $1", ["k1"]);
    const [third] = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    expect(third!.attempts).toBe(3);

    const dead = await outbox.markFailed({
      key: "k1",
      token: third!.processingToken!,
      attempts: 3,
      lastError: "llm down #3",
      maxAttempts: 3,
      backoffMs: 5_000,
    });
    expect(dead).toBe(true);
    db = await pool.query(
      "SELECT status, attempts, last_error, dead_letter_at FROM side_effect_outbox WHERE key = $1",
      ["k1"],
    );
    expect(db.rows[0].status).toBe("dead-letter");
    expect(Number(db.rows[0].attempts)).toBe(3);
    expect(db.rows[0].last_error).toBe("llm down #3");
    expect(db.rows[0].dead_letter_at).not.toBeNull();

    // dead-letter 不再被领取
    const none = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    expect(none).toHaveLength(0);
  });

  it("expired processing lease is reclaimed by a later claim", async () => {
    await enqueue("k1");
    const [first] = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    // 模拟 lease 过期：locked_until 拨回过去
    await pool.query("UPDATE side_effect_outbox SET locked_until = now() - interval '1 second' WHERE key = $1", ["k1"]);

    const [second] = await outboxB.claimPending(1, { owner: "drainer-b", leaseMs: 60_000 });
    expect(second).toBeDefined();
    expect(second!.owner).toBe("drainer-b");
    expect(second!.attempts).toBe(2);
    expect(second!.processingToken).not.toBe(first!.processingToken);

    // 新 owner 拿到 lease；旧 owner 的 complete 必须 CAS 失败
    const staleComplete = await outbox.complete("k1", first!.processingToken!);
    expect(staleComplete).toBe(false);
    const db = await pool.query("SELECT status, owner, processing_token FROM side_effect_outbox WHERE key = $1", ["k1"]);
    expect(db.rows[0].status).toBe("processing");
    expect(db.rows[0].owner).toBe("drainer-b");
    expect(db.rows[0].processing_token).toBe(second!.processingToken);
  });

  it("drainer uses claim token for complete/markFailed", async () => {
    await enqueue("k-ok", "refine", { n: 1 });
    await enqueue("k-bad", "refine", { n: 2 });
    const handled: unknown[] = [];
    const drainer = createSideEffectDrainer({
      outbox: outbox as SideEffectOutboxPort,
      handlers: {
        refine: async (payload) => {
          if ((payload as { n: number }).n === 1) { handled.push(payload); return; }
          throw new Error("llm down");
        },
      },
    });
    await drainer.drainOnce();
    expect(handled).toHaveLength(1);
    let db = await pool.query("SELECT status, attempts, last_error FROM side_effect_outbox WHERE key = $1", ["k-ok"]);
    expect(db.rows[0].status).toBe("done");
    db = await pool.query("SELECT status, attempts, last_error FROM side_effect_outbox WHERE key = $1", ["k-bad"]);
    expect(db.rows[0].status).toBe("pending");
    expect(Number(db.rows[0].attempts)).toBe(1);
    expect(db.rows[0].last_error).toBe("llm down");
  });

  it("enqueue and task commit are atomic: enqueue failure rolls back commit", async () => {
    const taskId = "task-atomic";
    const leaseId = "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6";
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, title, text, created_by, status, assigned_role, lease_id, lease_generation)
       VALUES ($1, 'tenant-a', 't', 'x', 'test', 'claimed', 'developer', $2, 1)`,
      [taskId, leaseId],
    );
    const outcome: TaskOutcome = {
      lease: { taskId, leaseId, generation: 1 },
      status: "completed",
      result: { ok: true },
      artifacts: [],
      traceId: "trace-1",
    };
    const repo = createPgTaskRepository(pool);

    // side_effect_outbox.key 为 NOT NULL：故意传 null 触发 INSERT 失败 → 事务回滚。
    const badSideEffect = {
      key: null as unknown as string,
      tenantId: "tenant-a",
      kind: "refine",
      payload: { n: 1 },
    };
    await expect(
      repo.commit(outcome, { sideEffects: [badSideEffect] }),
    ).rejects.toThrow();

    let db = await pool.query("SELECT status FROM tasks WHERE id = $1", [taskId]);
    expect(db.rows[0].status).toBe("claimed");
    db = await pool.query("SELECT COUNT(*)::int AS n FROM side_effect_outbox WHERE key = $1", ["refine:tenant-a:task-atomic:1"]);
    expect(db.rows[0].n).toBe(0);

    // 正例：同事务提交 task + outbox row。
    const ok = await repo.commit(outcome, {
      sideEffects: [{
        key: "refine:tenant-a:task-atomic:1",
        tenantId: "tenant-a",
        kind: "refine",
        payload: { n: 1 },
      }],
    });
    expect(ok).toEqual({ committed: true });
    db = await pool.query("SELECT status FROM tasks WHERE id = $1", [taskId]);
    expect(db.rows[0].status).toBe("completed");
    db = await pool.query("SELECT status FROM side_effect_outbox WHERE key = $1", ["refine:tenant-a:task-atomic:1"]);
    expect(db.rows[0].status).toBe("pending");
  });
});
