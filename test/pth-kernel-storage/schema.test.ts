import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool } from "../../src/pth/kernel/storage/pg";
import { applySchema, SCHEMA_VERSION } from "../../src/pth/kernel/storage/schema";

// --- Docker 可用性守卫（Global Constraints：无 docker 环境必须 SKIP 而非 FAIL）---
// 模式同 Task 1（test/pth-kernel-storage/pg.test.ts）：getContainerRuntimeClient() 内部执行
// dockerode.info()，daemon 不可用时抛错 → 走 skip 分支。PTH_TEST_NO_DOCKER=1 强制模拟无 docker。
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

suite("schema", () => {
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

  it("applies schema idempotently", async () => {
    await applySchema(pool); // 二次应用不报错
    const res = await pool.query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1");
    expect(res.rows[0].version).toBe(SCHEMA_VERSION);
  });

  it("creates all 12 tables", async () => {
    const tables = ["task_templates","tasks","memory_entries","memory_buffer","memory_idem","memory_retry","memory_index","lab_events","credit_tx","transcripts","audit_log","skills"];
    for (const t of tables) {
      const res = await pool.query("SELECT to_regclass($1) as r", [t]);
      expect(res.rows[0].r, `table ${t} should exist`).toBeTruthy();
    }
  });

  it("tasks status CHECK rejects invalid status", async () => {
    await expect(
      pool.query(`INSERT INTO tasks (id, title, text, created_by, status) VALUES ('t1','x','y','me','calimed')`),
    ).rejects.toThrow();
  });

  it("memory_entries anchors non-empty CHECK", async () => {
    await expect(
      pool.query(`INSERT INTO memory_entries (id, kind, anchors, content) VALUES ('m1','fact','[]','x')`),
    ).rejects.toThrow();
  });

  it("tasks 具备真实 lease 列（P1-1）", async () => {
    const cols = await pool.query(
      `SELECT column_name, data_type, column_default
       FROM information_schema.columns
       WHERE table_name = 'tasks' AND column_name IN ('lease_id','lease_generation','lease_expires_at')
       ORDER BY column_name`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(["lease_expires_at", "lease_generation", "lease_id"]);
    const gen = cols.rows.find((r) => r.column_name === "lease_generation");
    expect(gen.data_type).toBe("bigint");
    expect(String(gen.column_default)).toContain("0");
  });

  it("lease 索引 idx_tasks_active_lease 存在（partial: status=claimed）", async () => {
    const res = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'tasks' AND indexname = 'idx_tasks_active_lease'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(String(res.rows[0].indexdef)).toContain("WHERE (status = 'claimed'::text)");
  });

  it("存量行 lease 字段默认安全（null lease_id / generation 0）", async () => {
    await pool.query(`INSERT INTO tasks (id, title, text, created_by, status) VALUES ('legacy-lease','x','y','me','pending')`);
    const res = await pool.query(`SELECT lease_id, lease_generation, lease_expires_at FROM tasks WHERE id = 'legacy-lease'`);
    expect(res.rows[0].lease_id).toBeNull();
    expect(Number(res.rows[0].lease_generation)).toBe(0);
    expect(res.rows[0].lease_expires_at).toBeNull();
  });
});
