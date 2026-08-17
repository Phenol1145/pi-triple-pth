import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool } from "../../src/pth/kernel/storage/pg";
import { applySchema } from "../../src/pth/kernel/storage/schema";
import { createDataWorld } from "../../src/pth/kernel/storage/index";

// --- Docker 可用性守卫（Global Constraints：无 docker 环境必须 SKIP 而非 FAIL）---
// 模式同 Task 1-5（pg.test.ts / schema.test.ts / task-store-pg.test.ts / memory-store-pg.test.ts /
// transcript-audit.test.ts）：getContainerRuntimeClient() 内部执行 dockerode.info()，daemon 不可用时
// 抛错 → 走 skip 分支。PTH_TEST_NO_DOCKER=1 强制模拟无 docker。
// 守卫自身的单元测试已由 pg.test.ts 覆盖（全 suite 唯一），此处不重复定义。
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

suite("data world assembly", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
  }, 120_000);


  it("queryReadOnly：vm memory.query 全链路（受限 SQL 查询记忆）", async () => {
    const dw = createDataWorld(pool);
    await dw.memory.write({ id: "qro-fn", kind: "tool-function", anchors: ["qro"], content: "fn()", status: "draft" });
    const rows = (await dw.queryReadOnly("SELECT kind, content FROM memory_entries WHERE anchors @> '[\"qro\"]'")) as Array<{ kind: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("tool-function");
    // 非 SELECT 拒绝（vm 侧同一执行器）
    await expect(dw.queryReadOnly("DELETE FROM memory_entries")).rejects.toThrow(/read-only/);
  });

  it("queryTemplate 受信模板通道（A2 Phase 4）：obs 工具可查 tasks/transcripts；LLM 面仍拒绝", async () => {
    const dw = createDataWorld(pool);
    const t = await dw.tasks.publish({ title: "obs-template", text: "x", createdBy: "me", tags: ["code"] });
    // 模板通道：tasks/transcripts 开放（真实池链路 obs.tasks/obs.search 修复）
    const taskRows = (await dw.queryTemplate("SELECT status FROM tasks WHERE id = '" + t.id + "'")) as Array<{ status: string }>;
    expect(taskRows.length).toBe(1);
    const trRows = await dw.queryTemplate("SELECT id FROM transcripts LIMIT 5");
    expect(Array.isArray(trRows)).toBe(true);
    // 模板通道同样强制 SELECT/单语句/LIMIT
    await expect(dw.queryTemplate("DELETE FROM tasks")).rejects.toThrow(/read-only/);
    await expect(dw.queryTemplate("SELECT 1; DROP TABLE tasks")).rejects.toThrow(/单条语句/);
    // LLM 面（queryReadOnly）不变——tasks/transcripts 依旧不开放
    await expect(dw.queryReadOnly("SELECT id FROM tasks LIMIT 5")).rejects.toThrow(/不开放/);
    await expect(dw.queryReadOnly("SELECT id FROM transcripts LIMIT 5")).rejects.toThrow(/不开放/);
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("createDataWorld exposes all stores", async () => {
    const dw = createDataWorld(pool);
    expect(dw.tasks).toBeDefined();
    expect(dw.memory).toBeDefined();
    expect(dw.transcripts).toBeDefined();
    expect(dw.audit).toBeDefined();
  });

  it("end-to-end: publish → claim → execute → submit → transcript", async () => {
    const dw = createDataWorld(pool);
    const t = await dw.tasks.publish({ title: "e2e", text: "do it", createdBy: "me", tags: ["code"] });
    const claimed = await dw.tasks.claimTopN("dev-worker", [t.id]);
    expect(claimed.length).toBe(1);
    const tid = await dw.transcripts.create({ taskId: t.id, agentId: "dev-worker", body: [{ type: "result", ok: true }] });
    // Fix wave Finding #3：transcript create 后验证可查（body 断言）
    const got = await dw.transcripts.get(tid);
    expect(got?.body[0].type).toBe("result");
    await dw.tasks.submit("dev-worker", t.id, { ref: tid });
    // Fix wave Finding #3：submit 后持久化状态必须为 completed
    expect((await pool.query("SELECT status FROM tasks WHERE id=$1", [t.id])).rows[0].status).toBe("completed");
    await dw.audit.write({ eventType: "task_completed", taskId: t.id, workerId: "dev-worker" });
    const events = await dw.audit.query({ eventType: "task_completed" });
    expect(events.length).toBe(1);
  });
});
