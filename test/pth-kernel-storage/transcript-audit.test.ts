import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool } from "../../src/pth/kernel/storage/pg";
import { applySchema } from "../../src/pth/kernel/storage/schema";
import { PgTranscriptStore } from "../../src/pth/kernel/storage/transcript-store";
import { PgAuditStore } from "../../src/pth/kernel/storage/audit-store";

// --- Docker 可用性守卫（Global Constraints：无 docker 环境必须 SKIP 而非 FAIL）---
// 模式同 Task 1/2/3/4（pg.test.ts / schema.test.ts / task-store-pg.test.ts / memory-store-pg.test.ts）：
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

suite("transcript + audit stores", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    // 适配说明（brief 测试 vs Task 2 schema 现实）：transcripts.task_id 有 FK → tasks(id)，
    // brief 测试直接用 taskId "task-1" 而该父任务不存在 → 需先造父任务行；否则 INSERT 违反外键。
    await pool.query(
      `INSERT INTO tasks (id, title, text, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      ["task-1", "t1", "task body", "dev"],
    );
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("transcript create/get/listByTask", async () => {
    const ts = new PgTranscriptStore(pool);
    const id = await ts.create({ taskId: "task-1", agentId: "dev", body: [{ type: "program", program: "x" }] });
    const got = await ts.get(id);
    expect(got?.body[0].type).toBe("program");
    const byTask = await ts.listByTask("task-1");
    expect(byTask.length).toBe(1);
  });

  it("audit write/query by eventType", async () => {
    const as = new PgAuditStore(pool);
    await as.write({ eventType: "task_claimed", workerId: "w1", taskId: "t1" });
    await as.write({ eventType: "task_submitted", workerId: "w1", taskId: "t1" });
    const claimed = await as.query({ eventType: "task_claimed" });
    expect(claimed.length).toBe(1);
    expect(claimed[0].workerId).toBe("w1");
  });
});
