import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPgPool, applySchema } from "@away_from/pth-kernel-storage";
import { TaskDependencyReconciler } from "../../src/pth/tasking/task-dependency-reconciler.js";
import { hasTestDatabase, startTestDatabase } from "../helpers.js";

const dbAvailable = await hasTestDatabase();
const suite = dbAvailable ? describe : describe.skip;

suite("task-dependency-reconciler（V1 最终收敛）", () => {
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

  it("孤儿 child 终态 → 补写 dependency 并唤醒 waiting_dependency 父任务", async () => {
    await insertTask("r-parent", "waiting_dependency", {});
    await insertTask("r-child", "completed", {
      delivery: {
        parent: { taskId: "r-parent", roleId: "developer", typePath: ["developer"] },
        path: ["developer", "coder"],
        lineageId: "r-parent",
      },
      result: { value: 7, summary: "ok" },
    });
    await pool.query(
      `INSERT INTO task_dependencies (tenant_id, parent_task_id, child_task_id, submission_key, spec_digest, status)
       VALUES ('tenant-a','r-parent','r-child','rk','rd','pending')`,
    );

    const reconciler = new TaskDependencyReconciler({ pool, intervalMs: 60_000 });
    const repaired = await reconciler.reconcile();
    expect(repaired).toBeGreaterThan(0);

    const dep = await pool.query(
      `SELECT status FROM task_dependencies WHERE child_task_id = 'r-child'`,
    );
    expect(dep.rows[0].status).toBe("satisfied");
    const parent = await pool.query(`SELECT status FROM tasks WHERE id = 'r-parent'`);
    expect(parent.rows[0].status).toBe("pending");
  });

  it("所有 dependency 已终态但父仍 waiting_dependency → requeue", async () => {
    await insertTask("r-parent2", "waiting_dependency", {});
    await insertTask("r-child2", "completed", {
      delivery: {
        parent: { taskId: "r-parent2", roleId: "developer", typePath: ["developer"] },
        path: ["developer", "coder"],
        lineageId: "r-parent2",
      },
    });
    await pool.query(
      `INSERT INTO task_dependencies (tenant_id, parent_task_id, child_task_id, submission_key, spec_digest, status, outcome_envelope)
       VALUES ('tenant-a','r-parent2','r-child2','rk2','rd2','satisfied',
         '{"status":"completed","summary":"s","provenance":[],"artifactRefs":[]}'::jsonb)`,
    );

    const reconciler = new TaskDependencyReconciler({ pool, intervalMs: 60_000 });
    const repaired = await reconciler.reconcile();
    expect(repaired).toBeGreaterThan(0);
    const parent = await pool.query(`SELECT status FROM tasks WHERE id = 'r-parent2'`);
    expect(parent.rows[0].status).toBe("pending");
  });
});
