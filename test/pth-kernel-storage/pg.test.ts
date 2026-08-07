import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool, withTx } from "../../src/pth/kernel/storage/pg";

// --- Docker 可用性守卫（Global Constraints：无 docker 环境必须 SKIP 而非 FAIL）---
// review finding 建议的 `new Docker().ping()` 在 testcontainers 12.1.0 已不存在
// （v11 container-runtime 重构移除了 Docker 类）；等价探测为 getContainerRuntimeClient()，
// 其内部执行 dockerode.info()，daemon 不可用时抛错 → 走 skip 分支。
// PTH_TEST_NO_DOCKER=1 环境变量开关：强制模拟无 docker（验证 skip 分支）。
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

// 守卫自身的单元测试：独立于被 gated 的 suite（无 docker 时也运行），验证 env 开关强制走 skip 分支
describe("pg test docker guard", () => {
  it("PTH_TEST_NO_DOCKER=1 forces the skip branch", async () => {
    const prev = process.env.PTH_TEST_NO_DOCKER;
    process.env.PTH_TEST_NO_DOCKER = "1";
    try {
      expect(await hasDocker()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PTH_TEST_NO_DOCKER;
      else process.env.PTH_TEST_NO_DOCKER = prev;
    }
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

suite("pg connection layer", () => {
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
      // 适配说明：pg 默认把 int8（count(*)）解析为字符串；此处显式转数值断言（不引入全局 setTypeParser）
      expect(Number(res.rows[0].c)).toBe(1);
    });
  });

  it("routes idle-client errors to the injected onError handler", async () => {
    const errors: Error[] = [];
    const pool2 = await createPgPool({
      connectionString: container.getConnectionUri(),
      onError: (err) => errors.push(err),
    });
    const killerPool = await createPgPool({ connectionString: container.getConnectionUri() });
    try {
      // 产生一个 idle 客户端并拿到其 backend pid
      await pool2.query("SELECT 1");
      const pid = (await pool2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      // 从独立连接终止该 backend → idle 客户端收到 FATAL 57P01 → pool emit 'error'
      // → 必须被注入的 handler 捕获而非崩进程（无监听时 Node 抛 Unhandled 'error' event）
      const killer = await killerPool.connect();
      await killer.query("SELECT pg_terminate_backend($1)", [pid]);
      killer.release();
      await waitFor(() => errors.length > 0);
      expect(errors[0]).toBeInstanceOf(Error);
    } finally {
      await killerPool.end();
      await pool2.end();
    }
  });
});
