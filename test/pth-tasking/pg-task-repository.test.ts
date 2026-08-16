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
