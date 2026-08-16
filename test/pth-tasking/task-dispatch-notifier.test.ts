import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool } from "../../src/pth/kernel/storage/pg.js";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import { TaskDispatchNotifier } from "../../src/pth/tasking/task-dispatch-notifier.js";

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

function fakeHub() {
  const handlers = new Set<(e: { kind?: string; taskId?: string }) => void>();
  return {
    subscribe(handler: (e: { kind?: string; taskId?: string }) => void): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    publish(e: { kind?: string; taskId?: string }): void {
      for (const h of handlers) void h(e);
    },
  };
}

suite("task-dispatch-notifier（W8 P2 事件驱动回流）", () => {
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

  async function insertTask(id: string, status: string, payload: unknown): Promise<void> {
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, title, text, created_by, assigned_role, status, payload)
       VALUES ($1,'tenant-a',$2,'x','me','developer',$3,$4::jsonb)`,
      [id, `title ${id}`, status, JSON.stringify(payload)],
    );
  }

  it("子任务终态事件 → 父任务 payload.childResult + 清理 dispatchWait（幂等）", async () => {
    const hub = fakeHub();
    const notifier = new TaskDispatchNotifier({ pool, activityHub: hub });
    notifier.start();
    try {
      await insertTask("n-parent", "claimed", {
        dispatchWait: { "n-child": { at: "2026-08-17T00:00:00.000Z" } },
      });
      await insertTask("n-child", "completed", {
        delivery: { parent: { taskId: "n-parent", roleId: "developer", typePath: ["developer"] }, path: ["developer", "coder"], lineageId: "n-parent" },
        result: { value: 42 },
        artifactRef: undefined,
      });

      hub.publish({ kind: "task.submit", taskId: "n-child" });
      // 订阅处理是 fire-and-forget 微任务——两次 handle 都跑完再断言
      await notifier.handle("n-child");
      const row = await pool.query("SELECT payload FROM tasks WHERE id = 'n-parent'");
      expect(row.rows[0].payload.childResult["n-child"]).toEqual({
        status: "completed",
        result: { value: 42 },
        artifactRef: null,
        summary: undefined,
      });
      expect(row.rows[0].payload.dispatchWait["n-child"]).toBeUndefined();
      // 幂等：再次处理同一终态事件不改变结果
      await expect(notifier.handle("n-child")).resolves.toBe(true);
    } finally {
      notifier.stop();
    }
  });

  it("父任务已终态 / 无 parent 盖章 → 不写回流", async () => {
    const notifier = new TaskDispatchNotifier({ pool, activityHub: fakeHub() });
    await insertTask("n-done-parent", "completed", {});
    await insertTask("n-done-child", "completed", {
      delivery: { parent: { taskId: "n-done-parent", roleId: "developer", typePath: ["developer"] }, path: ["developer", "coder"], lineageId: "n-done-parent" },
    });
    expect(await notifier.handle("n-done-child")).toBe(false);

    await insertTask("n-root-child", "rejected", {
      delivery: { path: ["developer"], lineageId: "n-root-child" },
    });
    expect(await notifier.handle("n-root-child")).toBe(false);
  });
});
