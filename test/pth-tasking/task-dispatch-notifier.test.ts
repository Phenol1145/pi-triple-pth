import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPgPool } from "@away_from/pth-kernel-storage";
import { applySchema } from "@away_from/pth-kernel-storage";
import { TaskDispatchNotifier } from "../../src/pth/tasking/task-dispatch-notifier.js";
import { hasTestDatabase, startTestDatabase } from "../helpers.js";

const dbAvailable = await hasTestDatabase();
const suite = dbAvailable ? describe : describe.skip;

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
  let stopDb: () => Promise<void>;
  let pool: Awaited<ReturnType<typeof createPgPool>>;

  beforeAll(async () => {
    const db = await startTestDatabase();
    stopDb = db.stop;
    pool = await createPgPool({ connectionString: db.connectionString });
    await applySchema(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await stopDb();
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

  it("V1：child terminal 更新 dependency 并 requeue waiting_dependency 父任务", async () => {
    const notifier = new TaskDispatchNotifier({ pool, activityHub: fakeHub() });
    await insertTask("v1-parent", "waiting_dependency", {});
    await insertTask("v1-child", "completed", {
      delivery: {
        parent: { taskId: "v1-parent", roleId: "developer", typePath: ["developer"] },
        path: ["developer", "coder"],
        lineageId: "v1-parent",
        artifactRef: { kind: "file", id: "archive://v1-child/out" },
      },
      result: { value: 42, summary: "done" },
    });
    await pool.query(
      `INSERT INTO task_dependencies (tenant_id, parent_task_id, child_task_id, submission_key, spec_digest, status)
       VALUES ('tenant-a','v1-parent','v1-child','k1','d1','pending')`,
    );

    expect(await notifier.handle("v1-child")).toBe(true);

    const dep = await pool.query(
      `SELECT status, outcome_envelope FROM task_dependencies WHERE child_task_id = 'v1-child'`,
    );
    expect(dep.rows[0].status).toBe("satisfied");
    expect(dep.rows[0].outcome_envelope.status).toBe("completed");

    const parent = await pool.query(
      `SELECT status, payload FROM tasks WHERE id = 'v1-parent'`,
    );
    expect(parent.rows[0].status).toBe("pending");
    expect(parent.rows[0].payload.childResult["v1-child"]).toMatchObject({ status: "completed", result: { value: 42 } });
  });

  it("V1/P0：child 快速终态时父任务仍 claimed——notifier 不得提前 requeue（防双 Attempt）", async () => {
    const notifier = new TaskDispatchNotifier({ pool, activityHub: fakeHub() });
    await insertTask("v1-p0-parent", "claimed", {});
    await insertTask("v1-p0-child", "completed", {
      delivery: {
        parent: { taskId: "v1-p0-parent", roleId: "developer", typePath: ["developer"] },
        path: ["developer", "coder"],
        lineageId: "v1-p0-parent",
      },
      result: { value: 1 },
    });
    await pool.query(
      `INSERT INTO task_dependencies (tenant_id, parent_task_id, child_task_id, submission_key, spec_digest, status)
       VALUES ('tenant-a','v1-p0-parent','v1-p0-child','k-p0','d-p0','pending')`,
    );

    expect(await notifier.handle("v1-p0-child")).toBe(true);

    const dep = await pool.query(
      `SELECT status FROM task_dependencies WHERE child_task_id = 'v1-p0-child'`,
    );
    expect(dep.rows[0].status).toBe("satisfied");
    const parent = await pool.query(
      `SELECT status FROM tasks WHERE id = 'v1-p0-parent'`,
    );
    // 父 Attempt 仍在运行，必须保持 claimed；等 commit 阶段再 fence 到 waiting_dependency。
    expect(parent.rows[0].status).toBe("claimed");
  });

  it("V1：child rejected 且 dependency 更新为 failed，父任务仍 requeue", async () => {
    const notifier = new TaskDispatchNotifier({ pool, activityHub: fakeHub() });
    await insertTask("v1-parent-reject", "waiting_dependency", {});
    await insertTask("v1-child-reject", "rejected", {
      delivery: {
        parent: { taskId: "v1-parent-reject", roleId: "developer", typePath: ["developer"] },
        path: ["developer", "coder"],
        lineageId: "v1-parent-reject",
      },
      result: { error: { code: "exec-failed", message: "boom" } },
    });
    await pool.query(
      `INSERT INTO task_dependencies (tenant_id, parent_task_id, child_task_id, submission_key, spec_digest, status)
       VALUES ('tenant-a','v1-parent-reject','v1-child-reject','k2','d2','pending')`,
    );

    expect(await notifier.handle("v1-child-reject")).toBe(true);
    const dep = await pool.query(
      `SELECT status, outcome_envelope FROM task_dependencies WHERE child_task_id = 'v1-child-reject'`,
    );
    expect(dep.rows[0].status).toBe("failed");
    expect(dep.rows[0].outcome_envelope.status).toBe("rejected");
    const parent = await pool.query(`SELECT status FROM tasks WHERE id = 'v1-parent-reject'`);
    expect(parent.rows[0].status).toBe("pending");
  });

  it("第三轮 P0：recursive cancel 后晚到 child terminal 不覆盖 cancelled dependency 或复活 parent", async () => {
    const notifier = new TaskDispatchNotifier({ pool, activityHub: fakeHub() });
    // 模拟 recursive cancel 已把父置 rejected、dependency 置 cancelled。
    await insertTask("r3-cancel-parent", "rejected", {});
    await insertTask("r3-cancel-child", "completed", {
      delivery: {
        parent: { taskId: "r3-cancel-parent", roleId: "developer", typePath: ["developer"] },
        path: ["developer", "coder"],
        lineageId: "r3-cancel-parent",
      },
      result: { value: "late success" },
    });
    await pool.query(
      `INSERT INTO task_dependencies (tenant_id, parent_task_id, child_task_id, submission_key, spec_digest, status, outcome_envelope)
       VALUES ('tenant-a','r3-cancel-parent','r3-cancel-child','r3-cancel','r3-cancel-d','cancelled',
         '{"status":"cancelled","summary":"任务已取消","provenance":[],"artifactRefs":[]}'::jsonb)`,
    );

    expect(await notifier.handle("r3-cancel-child")).toBe(false);

    const dep = await pool.query(
      `SELECT status, outcome_envelope FROM task_dependencies WHERE child_task_id = 'r3-cancel-child'`,
    );
    expect(dep.rows[0].status).toBe("cancelled");
    expect(dep.rows[0].outcome_envelope.status).toBe("cancelled");

    const parent = await pool.query(
      `SELECT status, payload FROM tasks WHERE id = 'r3-cancel-parent'`,
    );
    expect(parent.rows[0].status).toBe("rejected");
    expect(parent.rows[0].payload.childResult?.["r3-cancel-child"]).toBeUndefined();
  });
});
