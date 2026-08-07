import pg from "pg";
const { Pool } = pg;

export interface PgPoolOptions {
  connectionString?: string;   // 默认 process.env.DATABASE_URL
  max?: number;                // 默认 10
  onError?: (err: Error) => void; // pool 'error' handler，默认 console.error 记日志
}

export async function createPgPool(opts: PgPoolOptions = {}): Promise<pg.Pool> {
  const pool = new Pool({
    connectionString: opts.connectionString ?? process.env.DATABASE_URL,
    max: opts.max ?? 10,
  });
  // 空闲客户端出错时 pg Pool emit 'error'，无监听会 throw 崩进程；注入可配置 handler（默认记日志）
  pool.on("error", opts.onError ?? ((err: Error) => console.error("pg pool error:", err)));
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
