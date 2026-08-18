import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { Pool } from "pg";
import { MEMORY_SCHEMA_SQL, isVisible, runReadOnlyQuery, setSpaceLookup } from "@away_from/pth-memory";
import { createKnowledgeBroker } from "../../src/pth/execution/knowledge-broker.js";
import { createExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import type { ExecutionGrant } from "../../src/pth/contracts/index.js";

// Docker 可用性守卫：无 docker 环境 SKIP（与 packages/pth-memory/test/memory-store-pg.test.ts 同模式）。
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

const SECRET = "knowledge-broker-pg-secret-0123456789";
const key = createHmacGrantKeyProvider({ secret: SECRET });
const grantService = createExecutionGrantService({ keyProvider: key, clock: () => new Date("2030-01-01T00:00:00.000Z") });

function makeGrant(opts: { tenantId?: string; space?: string; capabilities?: string[]; roles?: string[] } = {}): ExecutionGrant {
  const tenantId = opts.tenantId ?? "tenant-a";
  const roles = opts.roles ?? ["developer"];
  return grantService.issue({
    lease: { taskId: "task-r2", leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6", generation: 1 },
    scope: {
      tenantId,
      principalId: `worker:${roles[0] ?? "developer"}`,
      roles,
      traceId: "trace-r2",
      space: opts.space ?? "meta",
    },
    workspace: { tenantId, workspaceId: "ws-r2", taskId: "task-r2" },
    language: "ts",
    capabilities: opts.capabilities ?? ["memory.read", "memory.query"],
    ttlMs: 60_000,
  });
}

suite("KnowledgeBroker raw query 数据面隔离（真实 PG）", () => {
  let container: PostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(MEMORY_SCHEMA_SQL);
    // 与 SQL 谓词同一祖先链：other/child 的父空间是 meta。
    setSpaceLookup({ get: (id) => (id === "other" || id === "child" ? { parent: "meta" } : undefined) });

    async function seed(entry: { id: string; tenantId: string; status: string; meta: Record<string, unknown>; content?: string }) {
      await pool.query(
        `INSERT INTO memory_entries (id, tenant_id, kind, anchors, content, status, meta)
         VALUES ($1, $2, 'domain-fact', $3::jsonb, $4, $5, $6::jsonb)`,
        [entry.id, entry.tenantId, JSON.stringify(["r2-seed"]), entry.content ?? entry.id, entry.status, JSON.stringify(entry.meta)],
      );
    }

    await seed({ id: "r2-a-official-meta", tenantId: "tenant-a", status: "official", meta: { spaceScope: { space: "meta", visibility: "public" } } });
    await seed({ id: "r2-b-official-meta", tenantId: "tenant-b", status: "official", meta: { spaceScope: { space: "meta", visibility: "public" } } });
    await seed({ id: "r2-a-draft-meta", tenantId: "tenant-a", status: "draft", meta: { spaceScope: { space: "meta", visibility: "public" } } });
    await seed({ id: "r2-a-archived-meta", tenantId: "tenant-a", status: "archived", meta: { spaceScope: { space: "meta", visibility: "public" } } });
    await seed({ id: "r2-a-official-other", tenantId: "tenant-a", status: "official", meta: { spaceScope: { space: "other", visibility: "private" } } });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  function makePgBroker(opts: { disableJsFilter?: boolean } = {}) {
    return createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: (sql) => runReadOnlyQuery(pool, sql),
        memory: {
          retrieve: async () => [],
          get: async () => undefined,
        },
      },
      // disableJsFilter=true：关闭 JS post-filter，结果只能来自 server 注入的 SQL 谓词——
      // 真实 PG 负向测试由此证明 tenant/status/space 是数据面强制，而非事后 JS 过滤兜底。
      isVisible: opts.disableJsFilter ? () => true : (meta, space) => isVisible(meta, space),
    });
  }

  it("raw query cannot read other tenant rows", async () => {
    const broker = makePgBroker({ disableJsFilter: true });
    const r = await broker.query({
      grant: makeGrant({ tenantId: "tenant-a", space: "meta" }),
      op: "query",
      sql: "SELECT id, tenant_id, status, meta FROM memory_entries",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.tenant_id)).not.toContain("tenant-b");
    expect(rows.map((row) => row.id)).not.toContain("r2-b-official-meta");
  });

  it("raw query cannot read draft or archived rows", async () => {
    const broker = makePgBroker({ disableJsFilter: true });
    const r = await broker.query({
      grant: makeGrant({ tenantId: "tenant-a", space: "meta" }),
      op: "query",
      sql: "SELECT id, tenant_id, status, meta FROM memory_entries",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.rows as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.id)).toContain("r2-a-official-meta");
    expect(rows.map((row) => row.id)).not.toContain("r2-a-draft-meta");
    expect(rows.map((row) => row.id)).not.toContain("r2-a-archived-meta");
  });

  it("raw query cannot read other space rows", async () => {
    const broker = makePgBroker({ disableJsFilter: true });
    const r = await broker.query({
      grant: makeGrant({ tenantId: "tenant-a", space: "meta" }),
      op: "query",
      sql: "SELECT id, tenant_id, status, meta FROM memory_entries",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.rows as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.id)).not.toContain("r2-a-official-other");
  });

  it("raw query rejects multi-statement and non-select", async () => {
    const broker = makePgBroker();
    const multi = await broker.query({
      grant: makeGrant({ tenantId: "tenant-a", space: "meta" }),
      op: "query",
      sql: "SELECT 1; DROP TABLE memory_entries",
    });
    expect(multi.ok).toBe(false);
    if (!multi.ok) expect(multi.status).toBe(400);

    const nonSelect = await broker.query({
      grant: makeGrant({ tenantId: "tenant-a", space: "meta" }),
      op: "query",
      sql: "UPDATE memory_entries SET status = 'draft' WHERE id = 'r2-a-official-meta'",
    });
    expect(nonSelect.ok).toBe(false);
    if (!nonSelect.ok) expect(nonSelect.status).toBe(400);
  });

  it("raw query rejects comma-join with second table", async () => {
    const broker = makePgBroker();
    for (const sql of [
      "SELECT meta FROM memory_entries, (SELECT 1) AS x",
      "SELECT meta FROM memory_entries, pg_roles",
    ]) {
      const r = await broker.query({
        grant: makeGrant({ tenantId: "tenant-a", space: "meta" }),
        op: "query",
        sql,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
  });

  it("raw query rejects function calls in select list", async () => {
    const broker = makePgBroker();
    const r = await broker.query({
      grant: makeGrant({ tenantId: "tenant-a", space: "meta" }),
      op: "query",
      sql: "SELECT pg_read_file('/etc/passwd'), meta FROM memory_entries",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toContain("函数调用");
    }
  });

  it("raw query without memory.query capability is 403（F2 门禁回归）", async () => {
    const broker = makePgBroker();
    const r = await broker.query({
      grant: makeGrant({ tenantId: "tenant-a", space: "meta", capabilities: ["memory.read"] }),
      op: "query",
      sql: "SELECT id, meta FROM memory_entries",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toContain("memory.query");
    }
  });

  it("platform-admin 跨租户默认 deny：admin 也按自身 grant tenant 查询，不能读取其他租户", async () => {
    const broker = makePgBroker({ disableJsFilter: true });
    const r = await broker.query({
      grant: makeGrant({ tenantId: "tenant-a", space: "meta", roles: ["platform-admin"] }),
      op: "query",
      sql: "SELECT id, tenant_id, status, meta FROM memory_entries",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.rows as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.tenant_id)).not.toContain("tenant-b");
    expect(rows.map((row) => row.id)).not.toContain("r2-b-official-meta");
  });
});
