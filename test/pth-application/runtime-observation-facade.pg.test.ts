/**
 * runtime-observation-facade.pg.test.ts — N30 Task 3（真实 PostgreSQL 投影测试）。
 *
 * 覆盖：
 *  - tenant 隔离：tenant A 查询中 tenant B 稳定 ID 零可见；
 *  - running 区间 endAt=null，终态区间有 endAt；
 *  - Intake Run/Stage 投影：workMode 固定 intake、attempt 稳定 ID 互异、parent 链在结果内可解析；
 *  - 分页：opaque cursor 翻页不重不漏，翻页间新行在后续页可见；
 *  - 跨 tenant cursor fail-closed；
 *  - durable 源变化可被下一查询观察到；
 *  - 投影零写入（tasks / intake 源表行数不变）。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool } from "../../src/pth/kernel/storage/pg.js";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import { validateRuntimeInterval } from "../../src/pth/contracts/runtime-observation.js";
import {
  RuntimeObservationError,
  RuntimeObservationFacade,
} from "../../src/pth/application/observation/runtime-observation-facade.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_FROM = Date.parse("2026-08-19T00:00:00.000Z");
const WINDOW_TO = WINDOW_FROM + DAY_MS;

type SqlRow = Record<string, unknown>;

async function seedTask(
  pool: Awaited<ReturnType<typeof createPgPool>>,
  row: {
    id: string;
    tenantId: string;
    title: string;
    status: string;
    workMode: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string | null;
    rejectsJson?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO tasks
       (id, tenant_id, title, text, created_by, status, work_mode, created_at, updated_at, completed_at, rejects)
     VALUES ($1,$2,$3,$4,'seed', $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, COALESCE($10::jsonb, '[]'::jsonb))`,
    [
      row.id,
      row.tenantId,
      row.title,
      `text of ${row.id}`,
      row.status,
      row.workMode,
      row.createdAt,
      row.updatedAt,
      row.completedAt ?? null,
      row.rejectsJson ?? null,
    ],
  );
}

async function seedTrustPolicy(pool: Awaited<ReturnType<typeof createPgPool>>, tenantId: string): Promise<void> {
  await pool.query(
    `INSERT INTO knowledge_trust_policies
       (tenant_id, policy_id, policy_version, policy_digest, spaces, valid_from, valid_until,
        approved_by_principal_id, approved_by_issuer, approval_method, approval_key_id,
        approval_signature, manifest, installed_by)
     VALUES ($1,'policy-seed','v1','seed-digest','[]'::jsonb,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',
             'human:seed','ptl-human-interface','signed-manifest','human:seed','seed-sig','{}'::jsonb,'seed')`,
    [tenantId],
  );
}

async function seedSubscription(
  pool: Awaited<ReturnType<typeof createPgPool>>,
  tenantId: string,
  subscriptionId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO knowledge_source_subscriptions
       (tenant_id, id, space, canonical_uri, domain_id, status, policy_id, policy_version,
        policy_digest, policy_rule_id, recrawl_interval_ms, next_crawl_at)
     VALUES ($1,$2,'space-a',$3,'seed-domain','active','policy-seed','v1','seed-digest','rule-1',60000,
             '2026-08-19T00:00:00.000Z')`,
    [tenantId, subscriptionId, `https://example.invalid/${subscriptionId}`],
  );
}

async function seedIntakeRun(
  pool: Awaited<ReturnType<typeof createPgPool>>,
  row: {
    tenantId: string;
    subscriptionId: string;
    runId: string;
    status: string;
    stage: string;
    attempt: number;
    createdAt: string;
    updatedAt: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO knowledge_intake_runs
       (tenant_id, id, subscription_id, reason, stage, status, attempt, created_at, updated_at)
     VALUES ($1,$2,$3,'initial',$4,$5,$6,$7::timestamptz,$8::timestamptz)`,
    [row.tenantId, row.runId, row.subscriptionId, row.stage, row.status, row.attempt, row.createdAt, row.updatedAt],
  );
}

async function seedIntakeAttempt(
  pool: Awaited<ReturnType<typeof createPgPool>>,
  row: {
    tenantId: string;
    runId: string;
    stage: string;
    attempt: number;
    leaseGeneration: number;
    disposition: string;
    createdAt: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO knowledge_intake_attempts
       (tenant_id, run_id, stage, attempt, lease_generation, lease_token_hash, input_hash,
        disposition, principal_id, execution_id, created_at)
     VALUES ($1,$2,$3,$4,$5,'seed-token-hash','',$6,'seed-principal','seed-exec',$7::timestamptz)`,
    [row.tenantId, row.runId, row.stage, row.attempt, row.leaseGeneration, row.disposition, row.createdAt],
  );
}

describe("RuntimeObservationFacade（PG 投影）", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let facade: RuntimeObservationFacade;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);

    // Tenant A：completed / running / failed / retrying 四种 Task 形态。
    await seedTask(pool, {
      id: "task-a-completed", tenantId: "tenant-a", title: "a completed", status: "completed",
      workMode: "run", createdAt: "2026-08-19T00:10:00.000Z", updatedAt: "2026-08-19T00:20:00.000Z",
      completedAt: "2026-08-19T00:20:00.000Z",
    });
    await seedTask(pool, {
      id: "task-a-running", tenantId: "tenant-a", title: "a running", status: "claimed",
      workMode: "run", createdAt: "2026-08-19T00:30:00.000Z", updatedAt: "2026-08-19T00:31:00.000Z",
    });
    await seedTask(pool, {
      id: "task-a-failed", tenantId: "tenant-a", title: "a failed", status: "rejected",
      workMode: "run", createdAt: "2026-08-19T00:40:00.000Z", updatedAt: "2026-08-19T00:50:00.000Z",
    });
    await seedTask(pool, {
      id: "task-a-retrying", tenantId: "tenant-a", title: "a retrying", status: "pending",
      workMode: "run", createdAt: "2026-08-19T00:55:00.000Z", updatedAt: "2026-08-19T00:56:00.000Z",
      rejectsJson: JSON.stringify([{ agentId: "w1", reason: "flaky", at: Date.parse("2026-08-19T00:56:00.000Z") }]),
    });

    // Tenant B：同样 Task 形态，必须零可见。
    await seedTask(pool, {
      id: "task-b-completed", tenantId: "tenant-b", title: "b completed", status: "completed",
      workMode: "run", createdAt: "2026-08-19T01:00:00.000Z", updatedAt: "2026-08-19T01:10:00.000Z",
      completedAt: "2026-08-19T01:10:00.000Z",
    });
    await seedTask(pool, {
      id: "task-b-running", tenantId: "tenant-b", title: "b running", status: "claimed",
      workMode: "run", createdAt: "2026-08-19T01:20:00.000Z", updatedAt: "2026-08-19T01:21:00.000Z",
    });

    // Intake 播种（tenant A 每个 open run 一个 subscription，绕开 open subscription 唯一索引；
    // tenant B 一套，用于跨 tenant 零可见与跨 tenant cursor 对抗）。
    await seedTrustPolicy(pool, "tenant-a");
    for (const sub of ["sub-a-completed", "sub-a-running", "sub-a-waiting", "sub-a-failed"]) {
      await seedSubscription(pool, "tenant-a", sub);
    }
    await seedTrustPolicy(pool, "tenant-b");
    await seedSubscription(pool, "tenant-b", "sub-tenant-b");

    await seedIntakeRun(pool, {
      tenantId: "tenant-a", subscriptionId: "sub-a-completed", runId: "run-a-completed",
      status: "completed", stage: "fetch", attempt: 1,
      createdAt: "2026-08-19T00:15:00.000Z", updatedAt: "2026-08-19T00:25:00.000Z",
    });
    await seedIntakeAttempt(pool, {
      tenantId: "tenant-a", runId: "run-a-completed", stage: "fetch", attempt: 1,
      leaseGeneration: 1, disposition: "leased", createdAt: "2026-08-19T00:15:00.000Z",
    });
    await seedIntakeAttempt(pool, {
      tenantId: "tenant-a", runId: "run-a-completed", stage: "fetch", attempt: 1,
      leaseGeneration: 1, disposition: "succeeded", createdAt: "2026-08-19T00:25:00.000Z",
    });

    await seedIntakeRun(pool, {
      tenantId: "tenant-a", subscriptionId: "sub-a-running", runId: "run-a-running",
      status: "leased", stage: "extract", attempt: 1,
      createdAt: "2026-08-19T00:45:00.000Z", updatedAt: "2026-08-19T00:46:00.000Z",
    });
    await seedIntakeAttempt(pool, {
      tenantId: "tenant-a", runId: "run-a-running", stage: "extract", attempt: 1,
      leaseGeneration: 1, disposition: "leased", createdAt: "2026-08-19T00:45:00.000Z",
    });

    await seedIntakeRun(pool, {
      tenantId: "tenant-a", subscriptionId: "sub-a-waiting", runId: "run-a-waiting",
      status: "waiting", stage: "promote", attempt: 2,
      createdAt: "2026-08-19T00:50:00.000Z", updatedAt: "2026-08-19T00:58:00.000Z",
    });
    await seedIntakeAttempt(pool, {
      tenantId: "tenant-a", runId: "run-a-waiting", stage: "promote", attempt: 1,
      leaseGeneration: 1, disposition: "leased", createdAt: "2026-08-19T00:50:00.000Z",
    });
    await seedIntakeAttempt(pool, {
      tenantId: "tenant-a", runId: "run-a-waiting", stage: "promote", attempt: 1,
      leaseGeneration: 1, disposition: "retryable-failed", createdAt: "2026-08-19T00:58:00.000Z",
    });
    await seedIntakeAttempt(pool, {
      tenantId: "tenant-a", runId: "run-a-waiting", stage: "promote", attempt: 2,
      leaseGeneration: 2, disposition: "leased", createdAt: "2026-08-19T01:00:00.000Z",
    });

    await seedIntakeRun(pool, {
      tenantId: "tenant-a", subscriptionId: "sub-a-failed", runId: "run-a-failed",
      status: "dead-letter", stage: "complete", attempt: 1,
      createdAt: "2026-08-19T01:05:00.000Z", updatedAt: "2026-08-19T01:15:00.000Z",
    });

    await seedIntakeRun(pool, {
      tenantId: "tenant-b", subscriptionId: "sub-tenant-b", runId: "run-b-completed",
      status: "completed", stage: "fetch", attempt: 1,
      createdAt: "2026-08-19T01:30:00.000Z", updatedAt: "2026-08-19T01:40:00.000Z",
    });

    facade = new RuntimeObservationFacade(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("tenant A 投影不包含 tenant B 的任何区间", async () => {
    const page = await facade.queryTimeline(
      { tenantId: "tenant-a" },
      { from: WINDOW_FROM, to: WINDOW_TO },
      { limit: 100 },
    );

    expect(page.intervals.length).toBeGreaterThanOrEqual(8);
    for (const interval of page.intervals) {
      expect(validateRuntimeInterval(interval).ok).toBe(true);
      expect(interval.tenantId).toBe("tenant-a");
      expect(interval.id).not.toContain("tenant-b");
    }
    const ids = page.intervals.map((i) => i.id);
    expect(ids).toContain("task:tenant-a:task-a-completed");
    expect(ids).toContain("task:tenant-a:task-a-running");
    expect(ids).toContain("task:tenant-a:task-a-failed");
    expect(ids).toContain("task:tenant-a:task-a-retrying");
    expect(ids).toContain("intake-run:tenant-a:run-a-completed");
    expect(ids).not.toContain("task:tenant-b:task-b-completed");
    expect(ids).not.toContain("intake-run:tenant-b:run-b-completed");
  });

  it("running 区间 endAt=null，终态区间有 endAt", async () => {
    const page = await facade.queryTimeline(
      { tenantId: "tenant-a" },
      { from: WINDOW_FROM, to: WINDOW_TO },
      { limit: 100 },
    );

    const runningTask = page.intervals.find((i) => i.id === "task:tenant-a:task-a-running");
    const runningRun = page.intervals.find((i) => i.id === "intake-run:tenant-a:run-a-running");
    const completed = page.intervals.find((i) => i.id === "task:tenant-a:task-a-completed");
    const failed = page.intervals.find((i) => i.id === "task:tenant-a:task-a-failed");

    expect(runningTask?.status).toBe("running");
    expect(runningTask?.endAt).toBeNull();
    expect(runningRun?.status).toBe("running");
    expect(runningRun?.endAt).toBeNull();
    expect(completed?.status).toBe("completed");
    expect(completed?.endAt).toBe(Date.parse("2026-08-19T00:20:00.000Z"));
    expect(failed?.status).toBe("failed");
    expect(failed?.endAt).toBe(Date.parse("2026-08-19T00:50:00.000Z"));
  });

  it("Intake Run/Stage 投影：workMode 固定 intake，attempt 稳定 ID 互异，parent 链可解析", async () => {
    const page = await facade.queryTimeline(
      { tenantId: "tenant-a" },
      { from: WINDOW_FROM, to: WINDOW_TO },
      { limit: 100 },
    );

    const runCompleted = page.intervals.find((i) => i.id === "intake-run:tenant-a:run-a-completed");
    expect(runCompleted?.workMode).toBe("intake");
    expect(runCompleted?.status).toBe("completed");
    expect(runCompleted?.endAt).toBe(Date.parse("2026-08-19T00:25:00.000Z"));

    const stages = page.intervals.filter((i) => i.kind === "intake-stage");
    expect(stages.length).toBeGreaterThanOrEqual(3);
    const stageIds = stages.map((i) => i.id);
    expect(new Set(stageIds).size).toBe(stageIds.length);

    for (const stage of stages) {
      expect(stage.workMode).toBe("intake");
      expect(stage.parentId).toBe(`intake-run:tenant-a:${stage.runId}`);
      expect(page.intervals.some((i) => i.id === stage.parentId)).toBe(true);
    }

    const retryingStage = stages.find((i) => i.status === "retrying");
    expect(retryingStage?.attempt).toBe(1);
    expect(retryingStage?.runId).toBe("run-a-waiting");
  });

  it("opaque cursor 分页不重不漏，翻页间新行在后续页可见", async () => {
    const first = await facade.queryTimeline(
      { tenantId: "tenant-a" },
      { from: WINDOW_FROM, to: WINDOW_TO },
      { limit: 2 },
    );
    expect(first.intervals.length).toBe(2);
    expect(first.nextCursor).toBeTruthy();

    // 翻页间插入新行（排序位置在既有全部行之后，仍在窗口内）。
    await seedTask(pool, {
      id: "task-a-paged", tenantId: "tenant-a", title: "a paged", status: "completed",
      workMode: "optimize", createdAt: "2026-08-19T02:00:00.000Z", updatedAt: "2026-08-19T02:10:00.000Z",
      completedAt: "2026-08-19T02:10:00.000Z",
    });

    const collected = [...first.intervals];
    let cursor = first.nextCursor;
    let guard = 0;
    while (cursor && guard < 20) {
      const page = await facade.queryTimeline(
        { tenantId: "tenant-a" },
        { from: WINDOW_FROM, to: WINDOW_TO },
        { cursor, limit: 2 },
      );
      collected.push(...page.intervals);
      cursor = page.nextCursor;
      guard += 1;
    }

    const ids = collected.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("task:tenant-a:task-a-paged");
    expect(ids).not.toContain("task:tenant-b:task-b-completed");
  });

  it("跨 tenant cursor 一律 fail-closed", async () => {
    const bPage = await facade.queryTimeline(
      { tenantId: "tenant-b" },
      { from: WINDOW_FROM, to: WINDOW_TO },
      { limit: 1 },
    );
    expect(bPage.nextCursor).toBeTruthy();

    await expect(
      facade.queryTimeline(
        { tenantId: "tenant-a" },
        { from: WINDOW_FROM, to: WINDOW_TO },
        { cursor: bPage.nextCursor, limit: 10 },
      ),
    ).rejects.toThrowError(RuntimeObservationError);
    await expect(
      facade.queryTimeline(
        { tenantId: "tenant-a" },
        { from: WINDOW_FROM, to: WINDOW_TO },
        { cursor: bPage.nextCursor, limit: 10 },
      ),
    ).rejects.toThrow(/tenant mismatch/);
  });

  it("durable 源变化可被下一查询观察到（Task 行由 tasks.work_mode 投影）", async () => {
    // 先确认 task-a-running 当前为 running。
    const before = await facade.queryTimeline(
      { tenantId: "tenant-a" },
      { from: WINDOW_FROM, to: WINDOW_TO },
      { limit: 100 },
    );
    const beforeRow = before.intervals.find((i) => i.id === "task:tenant-a:task-a-running");
    expect(beforeRow?.status).toBe("running");

    // 模拟 durable 源变更：worker 终态化（status/work_mode 同步变化）。
    await pool.query(
      `UPDATE tasks
          SET status = 'completed',
              work_mode = 'optimize',
              completed_at = '2026-08-19T02:20:00.000Z',
              updated_at = '2026-08-19T02:20:00.000Z'
        WHERE id = 'task-a-running'`,
    );

    const after = await facade.queryTimeline(
      { tenantId: "tenant-a" },
      { from: WINDOW_FROM, to: WINDOW_TO },
      { limit: 100 },
    );
    const afterRow = after.intervals.find((i) => i.id === "task:tenant-a:task-a-running");
    expect(afterRow?.status).toBe("completed");
    expect(afterRow?.workMode).toBe("optimize");
    expect(afterRow?.endAt).toBe(Date.parse("2026-08-19T02:20:00.000Z"));
    expect(afterRow?.sourceVersion).not.toBe(beforeRow?.sourceVersion);
  });

  it("投影零写入：tasks 与 knowledge_intake_* 源表行数在查询前后不变", async () => {
    const countsBefore = await pool.query<SqlRow>(
      `SELECT (SELECT count(*)::int FROM tasks) AS tasks,
              (SELECT count(*)::int FROM knowledge_intake_runs) AS runs,
              (SELECT count(*)::int FROM knowledge_intake_attempts) AS attempts`,
    );

    await facade.queryTimeline(
      { tenantId: "tenant-a" },
      { from: WINDOW_FROM, to: WINDOW_TO },
      { limit: 100 },
    );

    const countsAfter = await pool.query<SqlRow>(
      `SELECT (SELECT count(*)::int FROM tasks) AS tasks,
              (SELECT count(*)::int FROM knowledge_intake_runs) AS runs,
              (SELECT count(*)::int FROM knowledge_intake_attempts) AS attempts`,
    );
    expect(countsAfter.rows[0]).toEqual(countsBefore.rows[0]);
  });
});
