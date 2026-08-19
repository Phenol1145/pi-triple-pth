import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool } from "../../src/pth/kernel/storage/pg.js";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import {
  createPgTaskRepository,
  type PgTaskRepository,
} from "../../src/pth/tasking/adapters/pg-task-repository.js";
import type { TenantScope, TaskOutcome } from "../../src/pth/contracts/index.js";

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

const scope: TenantScope = { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-1" };

async function insertTask(
  pool: Awaited<ReturnType<typeof createPgPool>>,
  id: string,
  tenantId = "tenant-a",
  assignedRole = "developer",
  payload?: unknown,
): Promise<void> {
  await pool.query(
    `INSERT INTO tasks (id, tenant_id, title, text, created_by, assigned_role, status, payload)
     VALUES ($1, $2, $3, $4, 'repo-test', $5, 'pending', $6::jsonb)`,
    [id, tenantId, `title ${id}`, `text ${id}`, assignedRole, JSON.stringify(payload ?? {})],
  );
}

suite("pg task repository（P1-2）", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let repo: PgTaskRepository;

  /** N29 L1：CAS 失败必须零 side effect——按 (tenant_id, key) 计数。 */
  async function countOutbox(tenantId: string, key: string): Promise<number> {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM side_effect_outbox WHERE tenant_id = $1 AND key = $2`,
      [tenantId, key],
    );
    return r.rows[0].n as number;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    repo = createPgTaskRepository(pool, { leaseTtlMs: 60_000 });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("claim 只发一个真实 lease 并返回 work item", async () => {
    await insertTask(pool, "task-claim");
    const [claimed] = await repo.claim(scope, "developer", ["task-claim"]);
    expect(claimed).toBeTruthy();
    expect(claimed.lease.taskId).toBe("task-claim");
    expect(claimed.lease.leaseId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(claimed.lease.generation).toBe(1);
    expect(new Date(claimed.lease.deadlineAt).getTime()).toBeGreaterThan(Date.now());
    expect(claimed.work.title).toBe("title task-claim");
    expect(claimed.work.assignedRole).toBe("developer");
  });

  it("K2：claim 映射 payload.domains（去重排序）与合法 domainBinding", async () => {
    await insertTask(pool, "task-domains", "tenant-a", "developer", {
      domains: ["statistics", "mathematics", "statistics"],
      domainBinding: {
        matches: [
          { domainId: "mathematics", confidence: 1, evidence: ["explicit:mathematics"] },
          { domainId: "statistics", confidence: 1, evidence: ["explicit:statistics"] },
        ],
        primaryDomain: "mathematics",
        catalogVersion: "v1",
        resolverVersion: "v1-explicit-alias",
      },
    });
    const [claimed] = await repo.claim(scope, "developer", ["task-domains"]);
    expect(claimed.work.domains).toEqual(["mathematics", "statistics"]);
    expect(claimed.work.domainBinding?.primaryDomain).toBe("mathematics");
    expect(claimed.work.domainBinding?.resolverVersion).toBe("v1-explicit-alias");
  });

  it("K2：claim 映射 payload.domains 非法/domainBinding 非法 → domains=[] 且省略 binding", async () => {
    await insertTask(pool, "task-domains-invalid", "tenant-a", "developer", {
      domains: "mathematics",
      domainBinding: {
        matches: [{ domainId: "mathematics", confidence: 1, evidence: [] }],
        primaryDomain: "mathematics",
        catalogVersion: "v1",
        resolverVersion: "v1-explicit-alias",
      },
    });
    const [claimed] = await repo.claim(scope, "developer", ["task-domains-invalid"]);
    expect(claimed.work.domains).toEqual([]);
    expect(claimed.work.domainBinding).toBeUndefined();
  });

  it("K2：claim 映射 domainBinding 缺失 → domains 保留但 binding 省略", async () => {
    await insertTask(pool, "task-domains-no-binding", "tenant-a", "developer", {
      domains: ["mathematics"],
    });
    const [claimed] = await repo.claim(scope, "developer", ["task-domains-no-binding"]);
    expect(claimed.work.domains).toEqual(["mathematics"]);
    expect(claimed.work.domainBinding).toBeUndefined();
  });

  it("并发 claim 只发一个 lease（FOR UPDATE SKIP LOCKED）", async () => {
    await insertTask(pool, "task-race");
    const [a, b] = await Promise.all([
      repo.claim(scope, "developer", ["task-race"]),
      repo.claim(scope, "developer", ["task-race"]),
    ]);
    expect(a.length + b.length).toBe(1);
  });

  it("跨租户 claim 无效（tenant_id 过滤）", async () => {
    await insertTask(pool, "task-cross", "tenant-b");
    const got = await repo.claim(scope, "developer", ["task-cross"]);
    expect(got).toHaveLength(0);
  });

  it("重复/过期/wrong-generation outcome 一律 committed:false", async () => {
    await insertTask(pool, "task-cas");
    const [claimed] = await repo.claim(scope, "developer", ["task-cas"]);
    const base: TaskOutcome = {
      lease: claimed.lease,
      status: "completed",
      result: { value: 42 },
      artifacts: [],
      traceId: scope.traceId,
    };
    expect((await repo.commit(base)).committed).toBe(true);

    // 重复提交同 lease：不生效
    expect((await repo.commit(base)).committed).toBe(false);
    // 过期 generation：不生效
    expect((await repo.commit({ ...base, lease: { ...claimed.lease, generation: 0 } })).committed).toBe(false);
    // 错 leaseId：不生效
    expect((await repo.commit({ ...base, lease: { ...claimed.lease, leaseId: "00000000-0000-4000-8000-000000000000" } })).committed).toBe(false);

    const row = await pool.query("SELECT status FROM tasks WHERE id = 'task-cas'");
    expect(row.rows[0].status).toBe("completed");
  });

  it("recoverExpired 只清过期 claimed 行且 generation 单调不回退", async () => {
    await insertTask(pool, "task-recover");
    const [claimed] = await repo.claim(scope, "developer", ["task-recover"]);
    expect(claimed.lease.generation).toBe(1);
    await pool.query(
      `UPDATE tasks SET lease_expires_at = now() - interval '1 minute' WHERE id = 'task-recover'`,
    );
    const recovered = await repo.recoverExpired(new Date());
    expect(recovered).toBe(1);
    const row = await pool.query("SELECT status, lease_id, lease_generation FROM tasks WHERE id = 'task-recover'");
    expect(row.rows[0].status).toBe("pending");
    expect(row.rows[0].lease_id).toBeNull();
    expect(Number(row.rows[0].lease_generation)).toBe(1); // 不回退

    const [reclaimed] = await repo.claim(scope, "developer", ["task-recover"]);
    expect(reclaimed.lease.generation).toBe(2); // 单调递增
  });

  it("retryable reject 释放回队列（pending + lease 清空）", async () => {
    await insertTask(pool, "task-retry");
    const [claimed] = await repo.claim(scope, "developer", ["task-retry"]);
    const committed = await repo.commit({
      lease: claimed.lease,
      status: "rejected",
      retryable: true,
      error: { code: "soft", message: "retry later" },
      artifacts: [],
      traceId: scope.traceId,
    });
    expect(committed.committed).toBe(true);
    const row = await pool.query("SELECT status, lease_id FROM tasks WHERE id = 'task-retry'");
    expect(row.rows[0].status).toBe("pending");
    expect(row.rows[0].lease_id).toBeNull();
  });

  it("W8 P0：completed 回写 payload.result 与 delivery.artifactRef，保留既有 path/lineage 章", async () => {
    await insertTask(pool, "task-result-writeback", "tenant-a", "coder", {
      delivery: { path: ["origin", "developer", "coder"], lineageId: "root-1" },
    });
    const [claimed] = await repo.claim(scope, "coder", ["task-result-writeback"]);
    const committed = await repo.commit({
      lease: claimed.lease,
      status: "completed",
      result: { value: { answer: 42 } },
      artifacts: [{ kind: "file", uri: "archive://task-result-writeback/out.ts" }],
      traceId: scope.traceId,
    });
    expect(committed.committed).toBe(true);

    const row = await pool.query("SELECT status, payload FROM tasks WHERE id = 'task-result-writeback'");
    expect(row.rows[0].status).toBe("completed");
    expect(row.rows[0].payload.result).toEqual({ value: { answer: 42 } });
    expect(row.rows[0].payload.outputRef).toEqual({ ref: { value: { answer: 42 } } });
    expect(row.rows[0].payload.delivery).toEqual({
      path: ["origin", "developer", "coder"],
      lineageId: "root-1",
      artifactRef: { kind: "file", id: "archive://task-result-writeback/out.ts" },
    });
  });

  // ── N29 L1（§1.3 P0-1 / §1.4 P0-2）：CAS 失败零 side effect + 未过期 lease + tenant scope ──
  // 反例来源：docs/pth/n29-minimal-knowledge-intake-loop-feedback-plan.md §5 Task 1 Step 1。

  it("N29 P0-1：wrong generation does not enqueue side effects", async () => {
    await insertTask(pool, "task-n29-wrong-gen");
    const [claimed] = await repo.claim(scope, "developer", ["task-n29-wrong-gen"]);
    const effect = { key: "probe:wrong-generation", tenantId: "tenant-a", kind: "refine", payload: { probe: 1 } };
    const result = await repo.commit(
      {
        lease: { ...claimed.lease, generation: claimed.lease.generation + 1 },   // 错 generation
        status: "completed",
        result: { value: 1 },
        artifacts: [],
        traceId: scope.traceId,
      },
      { sideEffects: [effect], scope: { tenantId: "tenant-a" } },
    );
    expect(result).toEqual({ committed: false });
    expect(await countOutbox("tenant-a", effect.key)).toBe(0);
    const row = await pool.query("SELECT status FROM tasks WHERE id = 'task-n29-wrong-gen'");
    expect(row.rows[0].status).toBe("claimed");
  });

  it("N29 P0-1：wrong generation 在 retryable / rejected 分支同样零 side effect", async () => {
    await insertTask(pool, "task-n29-wrong-gen-retry");
    const [claimed] = await repo.claim(scope, "developer", ["task-n29-wrong-gen-retry"]);
    const wrongLease = { ...claimed.lease, generation: claimed.lease.generation + 1 };
    const retryEffect = { key: "probe:wrong-generation-retry", tenantId: "tenant-a", kind: "refine", payload: { probe: 2 } };
    const retry = await repo.commit(
      { lease: wrongLease, status: "rejected", retryable: true, error: { code: "soft", message: "later" }, artifacts: [], traceId: scope.traceId },
      { sideEffects: [retryEffect], scope: { tenantId: "tenant-a" } },
    );
    expect(retry).toEqual({ committed: false });
    expect(await countOutbox("tenant-a", retryEffect.key)).toBe(0);

    const rejectEffect = { key: "probe:wrong-generation-reject", tenantId: "tenant-a", kind: "refine", payload: { probe: 3 } };
    const rejected = await repo.commit(
      { lease: wrongLease, status: "rejected", retryable: false, error: { code: "hard", message: "boom" }, artifacts: [], traceId: scope.traceId },
      { sideEffects: [rejectEffect], scope: { tenantId: "tenant-a" } },
    );
    expect(rejected).toEqual({ committed: false });
    expect(await countOutbox("tenant-a", rejectEffect.key)).toBe(0);

    const row = await pool.query("SELECT status FROM tasks WHERE id = 'task-n29-wrong-gen-retry'");
    expect(row.rows[0].status).toBe("claimed");
  });

  it("N29 P0-2：expired lease cannot commit or enqueue", async () => {
    await insertTask(pool, "task-n29-expired");
    const [claimed] = await repo.claim(scope, "developer", ["task-n29-expired"]);
    await pool.query(`UPDATE tasks SET lease_expires_at = now() - interval '1 minute' WHERE id = 'task-n29-expired'`);
    const effect = { key: "probe:expired-lease", tenantId: "tenant-a", kind: "refine", payload: { probe: 4 } };
    const result = await repo.commit(
      { lease: claimed.lease, status: "completed", result: { value: 1 }, artifacts: [], traceId: scope.traceId },
      { sideEffects: [effect], scope: { tenantId: "tenant-a" } },
    );
    expect(result).toEqual({ committed: false });
    expect(await countOutbox("tenant-a", effect.key)).toBe(0);
    const row = await pool.query("SELECT status FROM tasks WHERE id = 'task-n29-expired'");
    expect(row.rows[0].status).toBe("claimed");
  });

  it("N29 P0-2：expired lease 在 retryable / rejected 分支同样不能提交", async () => {
    await insertTask(pool, "task-n29-expired-retry");
    const [claimed] = await repo.claim(scope, "developer", ["task-n29-expired-retry"]);
    await pool.query(`UPDATE tasks SET lease_expires_at = now() - interval '1 minute' WHERE id = 'task-n29-expired-retry'`);
    const retry = await repo.commit(
      { lease: claimed.lease, status: "rejected", retryable: true, error: { code: "soft", message: "later" }, artifacts: [], traceId: scope.traceId },
      { scope: { tenantId: "tenant-a" } },
    );
    expect(retry).toEqual({ committed: false });
    const rejected = await repo.commit(
      { lease: claimed.lease, status: "rejected", retryable: false, error: { code: "hard", message: "boom" }, artifacts: [], traceId: scope.traceId },
      { scope: { tenantId: "tenant-a" } },
    );
    expect(rejected).toEqual({ committed: false });
    const row = await pool.query("SELECT status FROM tasks WHERE id = 'task-n29-expired-retry'");
    expect(row.rows[0].status).toBe("claimed");
  });

  it("N29 P0-2：lease_expires_at IS NULL（旧行/无租约）不能提交", async () => {
    await insertTask(pool, "task-n29-null-lease");
    const [claimed] = await repo.claim(scope, "developer", ["task-n29-null-lease"]);
    await pool.query(`UPDATE tasks SET lease_expires_at = NULL WHERE id = 'task-n29-null-lease'`);
    const effect = { key: "probe:null-lease", tenantId: "tenant-a", kind: "refine", payload: { probe: 5 } };
    const result = await repo.commit(
      { lease: claimed.lease, status: "completed", result: { value: 1 }, artifacts: [], traceId: scope.traceId },
      { sideEffects: [effect], scope: { tenantId: "tenant-a" } },
    );
    expect(result).toEqual({ committed: false });
    expect(await countOutbox("tenant-a", effect.key)).toBe(0);
  });

  it("N29 P0-2：commit 携带错误 tenant scope（跨租户）不能提交且零 side effect", async () => {
    await insertTask(pool, "task-n29-cross-tenant");
    const [claimed] = await repo.claim(scope, "developer", ["task-n29-cross-tenant"]);
    const effect = { key: "probe:cross-tenant", tenantId: "tenant-b", kind: "refine", payload: { probe: 6 } };
    const result = await repo.commit(
      { lease: { taskId: claimed.lease.taskId, leaseId: claimed.lease.leaseId, generation: claimed.lease.generation }, status: "completed", result: { value: 1 }, artifacts: [], traceId: scope.traceId },
      { sideEffects: [effect], scope: { tenantId: "tenant-b" } },
    );
    expect(result).toEqual({ committed: false });
    expect(await countOutbox("tenant-b", effect.key)).toBe(0);
    const row = await pool.query("SELECT status FROM tasks WHERE id = 'task-n29-cross-tenant'");
    expect(row.rows[0].status).toBe("claimed");
  });

  it("N29 P0-2：缺少服务端盖章 tenant scope 的 outcome fail closed（零 side effect）", async () => {
    await insertTask(pool, "task-n29-no-scope");
    const [claimed] = await repo.claim(scope, "developer", ["task-n29-no-scope"]);
    const effect = { key: "probe:no-tenant-scope", tenantId: "tenant-a", kind: "refine", payload: { probe: 7 } };
    const result = await repo.commit(
      {
        // 裸 lease reference（无 scope）+ 无 opts.scope：服务端无法确认 tenant → fail closed
        lease: { taskId: claimed.lease.taskId, leaseId: claimed.lease.leaseId, generation: claimed.lease.generation },
        status: "completed",
        result: { value: 1 },
        artifacts: [],
        traceId: scope.traceId,
      },
      { sideEffects: [effect] },
    );
    expect(result).toEqual({ committed: false });
    expect(await countOutbox("tenant-a", effect.key)).toBe(0);
    const row = await pool.query("SELECT status FROM tasks WHERE id = 'task-n29-no-scope'");
    expect(row.rows[0].status).toBe("claimed");
  });

  it("N29 P0-1/P0-2 正向：未过期 lease + 正确 tenant scope → commit 且 side effect 同事务落库", async () => {
    await insertTask(pool, "task-n29-happy");
    const [claimed] = await repo.claim(scope, "developer", ["task-n29-happy"]);
    const effect = { key: "probe:happy-path", tenantId: "tenant-a", kind: "refine", payload: { probe: 8 } };
    const result = await repo.commit(
      { lease: claimed.lease, status: "completed", result: { value: 1 }, artifacts: [], traceId: scope.traceId },
      { sideEffects: [effect], scope: { tenantId: "tenant-a" } },
    );
    expect(result).toEqual({ committed: true });
    expect(await countOutbox("tenant-a", effect.key)).toBe(1);
  });

  // ── N29 再验收 P0-1：side effect 的 tenant 只能由聚合上下文（通过 CAS 的 task 行）盖章 ──
  // 反例来源：docs/pth/n29-minimal-intake-reacceptance-feedback.md §3 P0-1 / §8 条件 1。

  it("N29 refix P0-1：tenant-a 的 task 声明 tenantId=tenant-b 的 side effect → fail closed，两个 tenant 都零 outbox", async () => {
    await insertTask(pool, "task-refix-cross-tenant-se");
    const [claimed] = await repo.claim(scope, "developer", ["task-refix-cross-tenant-se"]);
    // 恶意/缺陷调用方：task 与 lease 都在 tenant-a，但 side effect 自报 tenant-b。
    const effect = { key: "probe:refix-cross-tenant-se", tenantId: "tenant-b", kind: "refine", payload: { probe: 101 } };
    const result = await repo.commit(
      { lease: claimed.lease, status: "completed", result: { value: 1 }, artifacts: [], traceId: scope.traceId },
      { sideEffects: [effect], scope: { tenantId: "tenant-a" } },
    );

    expect(result).toEqual({ committed: false });
    // 关键反例：tenant-b 的 outbox 必须零行（旧实现会在此写入一条 tenant-b 行）。
    expect(await countOutbox("tenant-b", effect.key)).toBe(0);
    // fail closed：连 tenant-a 也不落 side effect，且 task 终态未推进。
    expect(await countOutbox("tenant-a", effect.key)).toBe(0);
    const row = await pool.query("SELECT status FROM tasks WHERE id = 'task-refix-cross-tenant-se'");
    expect(row.rows[0].status).toBe("claimed");
  });

  it("N29 refix P0-1：retryable / rejected 分支的跨 tenant side effect 同样 fail closed", async () => {
    await insertTask(pool, "task-refix-cross-tenant-se-retry");
    const [claimedRetry] = await repo.claim(scope, "developer", ["task-refix-cross-tenant-se-retry"]);
    const retryEffect = { key: "probe:refix-cross-tenant-retry", tenantId: "tenant-b", kind: "refine", payload: { probe: 102 } };
    const retry = await repo.commit(
      {
        lease: claimedRetry.lease,
        status: "rejected",
        retryable: true,
        error: { code: "soft", message: "later" },
        artifacts: [],
        traceId: scope.traceId,
      },
      { sideEffects: [retryEffect], scope: { tenantId: "tenant-a" } },
    );
    expect(retry).toEqual({ committed: false });
    expect(await countOutbox("tenant-b", retryEffect.key)).toBe(0);
    expect((await pool.query("SELECT status FROM tasks WHERE id = 'task-refix-cross-tenant-se-retry'")).rows[0].status).toBe(
      "claimed",
    );

    await insertTask(pool, "task-refix-cross-tenant-se-reject");
    const [claimedReject] = await repo.claim(scope, "developer", ["task-refix-cross-tenant-se-reject"]);
    const rejectEffect = { key: "probe:refix-cross-tenant-reject", tenantId: "tenant-b", kind: "refine", payload: { probe: 103 } };
    const rejected = await repo.commit(
      {
        lease: claimedReject.lease,
        status: "rejected",
        retryable: false,
        error: { code: "hard", message: "boom" },
        artifacts: [],
        traceId: scope.traceId,
      },
      { sideEffects: [rejectEffect], scope: { tenantId: "tenant-a" } },
    );
    expect(rejected).toEqual({ committed: false });
    expect(await countOutbox("tenant-b", rejectEffect.key)).toBe(0);
    expect((await pool.query("SELECT status FROM tasks WHERE id = 'task-refix-cross-tenant-se-reject'")).rows[0].status).toBe(
      "claimed",
    );
  });

  it("N29 refix P0-1：省略 tenantId 的 side effect 由通过 CAS 的 task 行盖章为 tenant-a", async () => {
    await insertTask(pool, "task-refix-stamped-se");
    const [claimed] = await repo.claim(scope, "developer", ["task-refix-stamped-se"]);
    // 服务端盖章：调用方完全不声明 tenant，仓库从 CAS RETURNING 的 tasks.tenant_id 盖章。
    const result = await repo.commit(
      { lease: claimed.lease, status: "completed", result: { value: 1 }, artifacts: [], traceId: scope.traceId },
      {
        sideEffects: [{ key: "probe:refix-stamped-se", kind: "refine", payload: { probe: 104 } }],
        scope: { tenantId: "tenant-a" },
      },
    );
    expect(result).toEqual({ committed: true });
    expect(await countOutbox("tenant-a", "probe:refix-stamped-se")).toBe(1);
    expect(await countOutbox("tenant-b", "probe:refix-stamped-se")).toBe(0);
    const stamped = await pool.query(
      `SELECT tenant_id FROM side_effect_outbox WHERE key = 'probe:refix-stamped-se'`,
    );
    expect(stamped.rows.map((r) => r.tenant_id)).toEqual(["tenant-a"]);
  });

  it("W8 P0：completed 无产物不写 artifactRef；rejected 回写错误摘要", async () => {
    await insertTask(pool, "task-no-artifact", "tenant-a", "coder", {
      delivery: { path: ["origin", "developer", "coder"], lineageId: "root-2" },
    });
    const [claimedA] = await repo.claim(scope, "coder", ["task-no-artifact"]);
    await repo.commit({
      lease: claimedA.lease,
      status: "completed",
      result: { value: "plain" },
      artifacts: [],
      traceId: scope.traceId,
    });
    let row = await pool.query("SELECT payload FROM tasks WHERE id = 'task-no-artifact'");
    expect(row.rows[0].payload.result).toEqual({ value: "plain" });
    expect(row.rows[0].payload.delivery).toEqual({
      path: ["origin", "developer", "coder"],
      lineageId: "root-2",
    });

    await insertTask(pool, "task-rejected-writeback", "tenant-a", "coder");
    const [claimedB] = await repo.claim(scope, "coder", ["task-rejected-writeback"]);
    await repo.commit({
      lease: claimedB.lease,
      status: "rejected",
      retryable: false,
      error: { code: "exec-failed", message: "syntax boom" },
      artifacts: [],
      traceId: scope.traceId,
    });
    row = await pool.query("SELECT status, payload FROM tasks WHERE id = 'task-rejected-writeback'");
    expect(row.rows[0].status).toBe("rejected");
    expect(row.rows[0].payload.result).toEqual({ error: { code: "exec-failed", message: "syntax boom" } });
  });
});
