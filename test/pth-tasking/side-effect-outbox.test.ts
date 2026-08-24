import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { Pool } from "pg";
import {
  PgSideEffectOutbox,
  createSideEffectDrainer,
  type SideEffectOutboxPort,
} from "@away_from/pth-kernel-storage";
import { createPgTaskRepository } from "../../src/pth/tasking/adapters/pg-task-repository.js";
import type { TaskOutcome } from "@away_from/pth-contracts";
import { SCHEMA_SQL } from "@away_from/pth-kernel-storage";

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
  let container: StartedPostgreSqlContainer;
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
    const wrong = await outbox.complete({ tenantId: "tenant-a", key: "k1", token: "wrong-token" });
    expect(wrong).toBe(false);

    const db = await pool.query("SELECT status, processing_token FROM side_effect_outbox WHERE key = $1", ["k1"]);
    expect(db.rows[0].status).toBe("processing");
    expect(db.rows[0].processing_token).toBe(row!.processingToken);

    const ok = await outbox.complete({ tenantId: "tenant-a", key: "k1", token: row!.processingToken! });
    expect(ok).toBe(true);
    const after = await pool.query("SELECT status, done_at FROM side_effect_outbox WHERE key = $1", ["k1"]);
    expect(after.rows[0].status).toBe("done");
    expect(after.rows[0].done_at).not.toBeNull();
  });

  it("stale handler cannot move completed row back to pending", async () => {
    await enqueue("k1");
    const [row] = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    expect(await outbox.complete({ tenantId: "tenant-a", key: "k1", token: row!.processingToken! })).toBe(true);

    const stale = await outbox.markFailed({
      tenantId: "tenant-a",
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
      tenantId: "tenant-a",
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
      tenantId: "tenant-a",
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
      tenantId: "tenant-a",
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
    const staleComplete = await outbox.complete({ tenantId: "tenant-a", key: "k1", token: first!.processingToken! });
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

  // ── N29 L1（§1.5 P0-3）：outbox 身份必须是 (tenant_id, key) + exact payload ──────
  // 反例来源：docs/pth/plan/n29-minimal-knowledge-intake-loop-feedback-plan.md §5 Task 1 Step 1。

  async function countByTenantKey(tenantId: string, key: string): Promise<number> {
    const r = await pool.query(
      "SELECT count(*)::int AS n FROM side_effect_outbox WHERE tenant_id = $1 AND key = $2",
      [tenantId, key],
    );
    return r.rows[0].n as number;
  }

  async function countByKey(key: string): Promise<number> {
    const r = await pool.query("SELECT count(*)::int AS n FROM side_effect_outbox WHERE key = $1", [key]);
    return r.rows[0].n as number;
  }

  it("N29 P0-3：same tenant/key with a different payload conflicts", async () => {
    await outbox.enqueue({ key: "k-n29-conflict", tenantId: "tenant-a", kind: "refine", payload: { n: 1 } });
    await expect(
      outbox.enqueue({ key: "k-n29-conflict", tenantId: "tenant-a", kind: "refine", payload: { n: 2 } }),
    ).rejects.toThrow(/conflict/);
    // 首写 payload 不被覆盖，也不静默丢弃后者（显式 conflict）
    const db = await pool.query(
      "SELECT payload FROM side_effect_outbox WHERE tenant_id = 'tenant-a' AND key = 'k-n29-conflict'",
    );
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].payload).toEqual({ n: 1 });
  });

  it("N29 P0-3：same tenant/key with a different kind conflicts", async () => {
    await outbox.enqueue({ key: "k-n29-kind", tenantId: "tenant-a", kind: "refine", payload: { n: 1 } });
    await expect(
      outbox.enqueue({ key: "k-n29-kind", tenantId: "tenant-a", kind: "promotion-index", payload: { n: 1 } }),
    ).rejects.toThrow(/conflict/);
    const db = await pool.query(
      "SELECT kind FROM side_effect_outbox WHERE tenant_id = 'tenant-a' AND key = 'k-n29-kind'",
    );
    expect(db.rows[0].kind).toBe("refine");
  });

  it("N29 P0-3：exact replay（同 kind + payload + payload_hash）幂等不新增行", async () => {
    const input = { key: "k-n29-replay", tenantId: "tenant-a", kind: "refine", payload: { n: 1, nested: { a: 1, b: 2 } } };
    await outbox.enqueue(input);
    // 键序不同但 payload 等值：稳定 hash 必须判为同一 payload（幂等重放）
    await outbox.enqueue({ ...input, payload: { nested: { b: 2, a: 1 }, n: 1 } });
    expect(await countByTenantKey("tenant-a", "k-n29-replay")).toBe(1);
    const db = await pool.query(
      "SELECT status, attempts, payload_hash FROM side_effect_outbox WHERE tenant_id = 'tenant-a' AND key = 'k-n29-replay'",
    );
    expect(db.rows[0].status).toBe("pending");
    expect(Number(db.rows[0].attempts)).toBe(0);
    expect(db.rows[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("N29 P0-3：different tenants may reuse the same outbox key", async () => {
    const effect = { key: "k-n29-shared", kind: "refine", payload: { n: 1 } };
    await outbox.enqueue({ ...effect, tenantId: "tenant-a" });
    await outbox.enqueue({ ...effect, tenantId: "tenant-b" });
    expect(await countByKey("k-n29-shared")).toBe(2);
    const db = await pool.query(
      "SELECT tenant_id FROM side_effect_outbox WHERE key = $1 ORDER BY tenant_id",
      ["k-n29-shared"],
    );
    expect(db.rows.map((r: { tenant_id: string }) => r.tenant_id)).toEqual(["tenant-a", "tenant-b"]);
  });

  it("N29 P0-3：complete/markFailed 按 tenant + key + token 匹配（跨 tenant 不可完成）", async () => {
    await outbox.enqueue({ key: "k-n29-tenant-cas", tenantId: "tenant-a", kind: "refine", payload: { n: 1 } });
    await outbox.enqueue({ key: "k-n29-tenant-cas", tenantId: "tenant-b", kind: "refine", payload: { n: 1 } });
    const rows = await outbox.claimPending(2, { owner: "drainer-a", leaseMs: 60_000 });
    expect(rows).toHaveLength(2);
    const rowA = rows.find((r) => r.tenantId === "tenant-a")!;
    const rowB = rows.find((r) => r.tenantId === "tenant-b")!;

    // 错 tenant + 对 token：CAS 失败（tenant 参与 WHERE）
    expect(await outbox.complete({ tenantId: "tenant-b", key: "k-n29-tenant-cas", token: rowA.processingToken! })).toBe(false);
    expect(await outbox.complete({ tenantId: "tenant-a", key: "k-n29-tenant-cas", token: rowA.processingToken! })).toBe(true);

    expect(await outbox.markFailed({
      tenantId: "tenant-a", key: "k-n29-tenant-cas", token: rowB.processingToken!, attempts: 1, lastError: "cross tenant",
    })).toBe(false);
    expect(await outbox.markFailed({
      tenantId: "tenant-b", key: "k-n29-tenant-cas", token: rowB.processingToken!, attempts: 1, lastError: "own tenant",
    })).toBe(true);

    const db = await pool.query(
      "SELECT tenant_id, status FROM side_effect_outbox WHERE key = $1 ORDER BY tenant_id",
      ["k-n29-tenant-cas"],
    );
    expect(db.rows).toEqual([
      { tenant_id: "tenant-a", status: "done" },
      { tenant_id: "tenant-b", status: "pending" },
    ]);
  });

  it("N29 P0-3：claimPending 可按 tenant 收窄（跨 tenant 行不被领取）", async () => {
    await outbox.enqueue({ key: "k-n29-scope-a", tenantId: "tenant-a", kind: "refine", payload: { n: 1 } });
    await outbox.enqueue({ key: "k-n29-scope-b", tenantId: "tenant-b", kind: "refine", payload: { n: 1 } });
    const rows = await outbox.claimPending(10, { owner: "drainer-a", leaseMs: 60_000, tenantId: "tenant-a" });
    expect(rows.map((r) => r.key)).toEqual(["k-n29-scope-a"]);
    const db = await pool.query("SELECT status FROM side_effect_outbox WHERE key = $1", ["k-n29-scope-b"]);
    expect(db.rows[0].status).toBe("pending");
  });

  it("N29 P0-3：存量行（payload_hash 空）exact 重放 → 幂等回填而非 conflict", async () => {
    // 迁移安全性：旧库行的 payload_hash 为 ''（未回填）。同 kind + payload 的重放必须判为幂等，
    // 并顺带回填稳定 hash；payload 不同才 conflict。
    await outbox.enqueue({ key: "k-n29-legacy", tenantId: "tenant-a", kind: "refine", payload: { n: 1 } });
    await pool.query(
      "UPDATE side_effect_outbox SET payload_hash = '' WHERE tenant_id = 'tenant-a' AND key = 'k-n29-legacy'",
    );

    await outbox.enqueue({ key: "k-n29-legacy", tenantId: "tenant-a", kind: "refine", payload: { n: 1 } });
    expect(await countByTenantKey("tenant-a", "k-n29-legacy")).toBe(1);
    let db = await pool.query(
      "SELECT status, attempts, payload_hash FROM side_effect_outbox WHERE tenant_id = 'tenant-a' AND key = 'k-n29-legacy'",
    );
    expect(db.rows[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);   // 已回填
    expect(db.rows[0].status).toBe("pending");
    expect(Number(db.rows[0].attempts)).toBe(0);

    // 存量行 + 不同 payload 仍必须显式 conflict（不静默覆盖旧行）
    await pool.query(
      "UPDATE side_effect_outbox SET payload_hash = '' WHERE tenant_id = 'tenant-a' AND key = 'k-n29-legacy'",
    );
    await expect(
      outbox.enqueue({ key: "k-n29-legacy", tenantId: "tenant-a", kind: "refine", payload: { n: 2 } }),
    ).rejects.toThrow(/conflict/);
    db = await pool.query(
      "SELECT payload FROM side_effect_outbox WHERE tenant_id = 'tenant-a' AND key = 'k-n29-legacy'",
    );
    expect(db.rows[0].payload).toEqual({ n: 1 });
  });

  it("N29 P0-3：transaction-bound enqueue 复用调用方 client（回滚 → 零行）", async () => {
    const mod = await import("@away_from/pth-kernel-storage");
    const enqueueInTx = (mod as unknown as {
      enqueueSideEffectInTx?: (client: unknown, input: unknown) => Promise<unknown>;
    }).enqueueSideEffectInTx;
    expect(typeof enqueueInTx).toBe("function");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await enqueueInTx!(client, { key: "k-n29-tx", tenantId: "tenant-a", kind: "refine", payload: { n: 1 } });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await countByTenantKey("tenant-a", "k-n29-tx")).toBe(0);

    const client2 = await pool.connect();
    try {
      await client2.query("BEGIN");
      await enqueueInTx!(client2, { key: "k-n29-tx", tenantId: "tenant-a", kind: "refine", payload: { n: 1 } });
      await client2.query("COMMIT");
    } finally {
      client2.release();
    }
    expect(await countByTenantKey("tenant-a", "k-n29-tx")).toBe(1);
  });

  it("N29 P0-3：事务内 conflict 抛错 → 调用方事务可整体回滚（不静默丢弃）", async () => {
    const mod = await import("@away_from/pth-kernel-storage");
    const enqueueInTx = (mod as unknown as {
      enqueueSideEffectInTx?: (client: unknown, input: unknown) => Promise<unknown>;
    }).enqueueSideEffectInTx!;
    await outbox.enqueue({ key: "k-n29-tx-conflict", tenantId: "tenant-a", kind: "refine", payload: { n: 1 } });

    const client = await pool.connect();
    let thrown: unknown;
    try {
      await client.query("BEGIN");
      await enqueueInTx(client, { key: "k-n29-tx-conflict", tenantId: "tenant-a", kind: "refine", payload: { n: 99 } });
      await client.query("COMMIT");
    } catch (e) {
      thrown = e;
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(String((thrown as Error)?.message ?? "")).toMatch(/conflict/);
    const db = await pool.query(
      "SELECT payload FROM side_effect_outbox WHERE tenant_id = 'tenant-a' AND key = 'k-n29-tx-conflict'",
    );
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].payload).toEqual({ n: 1 });
  });

  it("enqueue and task commit are atomic: enqueue failure rolls back commit", async () => {
    const taskId = "task-atomic";
    const leaseId = "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6";
    // N29 P0-2：CAS 要求未过期 lease_expires_at——固定装置必须带真实租约窗口。
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, title, text, created_by, status, assigned_role, lease_id, lease_generation, lease_expires_at)
       VALUES ($1, 'tenant-a', 't', 'x', 'test', 'claimed', 'developer', $2, 1, now() + interval '5 minutes')`,
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
    // N29 P0-2：commit 必须携带服务端盖章 tenant scope（生产由 dispatcher 从 claim lease 取）。
    const commitScope = { scope: { tenantId: "tenant-a" } } as const;

    // side_effect_outbox.key 为 NOT NULL：故意传 null 触发 INSERT 失败 → 事务回滚。
    const badSideEffect = {
      key: null as unknown as string,
      tenantId: "tenant-a",
      kind: "refine",
      payload: { n: 1 },
    };
    await expect(
      repo.commit(outcome, { ...commitScope, sideEffects: [badSideEffect] }),
    ).rejects.toThrow();

    let db = await pool.query("SELECT status FROM tasks WHERE id = $1", [taskId]);
    expect(db.rows[0].status).toBe("claimed");
    db = await pool.query("SELECT COUNT(*)::int AS n FROM side_effect_outbox WHERE key = $1", ["refine:tenant-a:task-atomic:1"]);
    expect(db.rows[0].n).toBe(0);

    // 正例：同事务提交 task + outbox row。
    const ok = await repo.commit(outcome, {
      ...commitScope,
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
