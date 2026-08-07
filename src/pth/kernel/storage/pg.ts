import pg from "pg";
const { Pool, PoolClient } = pg;

export interface PgPoolOptions {
  connectionString?: string;   // 默认 process.env.DATABASE_URL
  max?: number;                // 默认 10
}

export async function createPgPool(opts: PgPoolOptions = {}): Promise<pg.Pool> {
  const pool = new Pool({
    connectionString: opts.connectionString ?? process.env.DATABASE_URL,
    max: opts.max ?? 10,
  });
  // 启动探测：连不上抛错（fail-fast）
  await pool.query("SELECT 1");
  return pool;
}

export async function withTx<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
