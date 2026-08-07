import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool, withTx } from "../../src/pth/kernel/storage/pg";

describe("pg connection layer", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("connects and runs a query", async () => {
    const res = await pool.query("SELECT 1 as one");
    expect(res.rows[0].one).toBe(1);
  });

  it("withTx commits on success", async () => {
    await withTx(pool, async (client) => {
      await client.query("CREATE TEMP TABLE t (x int)");
      await client.query("INSERT INTO t VALUES (1)");
    });
    // 验证事务内表存在（同一连接）
    await withTx(pool, async (client) => {
      const res = await client.query("SELECT count(*) as c FROM t");
      // 适配说明：pg 默认把 int8（count(*)）解析为字符串；此处显式转数值断言（不引入全局 setTypeParser，避免大整型精度风险）
      expect(Number(res.rows[0].c)).toBe(1);
    });
  });
});
