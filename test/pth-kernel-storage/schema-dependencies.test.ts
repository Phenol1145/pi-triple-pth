import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPgPool, applySchema } from "@away_from/pth-kernel-storage";
import { hasTestDatabase, startTestDatabase } from "../helpers.js";

const dbAvailable = await hasTestDatabase();
const suite = dbAvailable ? describe : describe.skip;

suite("持久化子任务委派 V1 schema", () => {
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

  it("tasks.status 允许 waiting_dependency", async () => {
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, title, text, created_by, assigned_role, status)
       VALUES ('wait-dep-task','tenant-a','t','x','me','developer','waiting_dependency')`,
    );
    const row = await pool.query("SELECT status FROM tasks WHERE id = 'wait-dep-task'");
    expect(row.rows[0].status).toBe("waiting_dependency");
  });

  it("task_submissions 与 task_dependencies 表结构、唯一约束", async () => {
    await pool.query(
      `INSERT INTO task_submissions (tenant_id, parent_task_id, child_task_id, submission_key, spec_digest, derived)
       VALUES ('tenant-a','parent-1','child-1','k1','d1',false)`,
    );
    await expect(
      pool.query(
        `INSERT INTO task_submissions (tenant_id, parent_task_id, child_task_id, submission_key, spec_digest, derived)
         VALUES ('tenant-a','parent-1','child-2','k1','d2',false)`,
      ),
    ).rejects.toThrow(/duplicate key/);

    await pool.query(
      `INSERT INTO task_dependencies (tenant_id, parent_task_id, child_task_id, submission_key, spec_digest, status)
       VALUES ('tenant-a','parent-1','child-1','k1','d1','pending')`,
    );
    await expect(
      pool.query(
        `INSERT INTO task_dependencies (tenant_id, parent_task_id, child_task_id, submission_key, spec_digest, status)
         VALUES ('tenant-a','parent-1','child-2','k2','d2','bogus')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("task_dependencies 唯一 child 约束", async () => {
    await expect(
      pool.query(
        `INSERT INTO task_dependencies (tenant_id, parent_task_id, child_task_id, submission_key, spec_digest, status)
         VALUES ('tenant-a','parent-2','child-1','k-other','d-other','pending')`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});
