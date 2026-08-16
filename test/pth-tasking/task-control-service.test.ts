import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool } from "../../src/pth/kernel/storage/pg.js";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import { PgTaskStore } from "../../src/pth/kernel/storage/task-store-pg.js";
import { TaskControlService } from "../../src/pth/tasking/task-control-service.js";
import { PgTaskQueries } from "../../src/pth/tasking/task-queries.js";
import type { TenantScope } from "../../src/pth/contracts/index.js";

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

const scopeA: TenantScope = { tenantId: "tenant-a", principalId: "tenant:tenant-a:tenant-agent", roles: ["tenant-agent"], traceId: "trace-a" };
const scopeB: TenantScope = { tenantId: "tenant-b", principalId: "tenant:tenant-b:tenant-agent", roles: ["tenant-agent"], traceId: "trace-b" };

suite("task control service（P1-3）", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let service: TaskControlService;
  let store: PgTaskStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    store = new PgTaskStore(pool);
    service = new TaskControlService({ store, pool, queries: new PgTaskQueries(pool) });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("publish：createdBy 只取服务器端 scope.principalId，body 字段不可覆盖", async () => {
    const task = await service.publish(
      { title: "t", text: "x", createdBy: "forged-body", tags: ["code"], payload: { tenant: "forged" }, tenantId: "tenant-forged" },
      scopeA,
    );
    expect(task).toMatchObject({ createdBy: "tenant:tenant-a:tenant-agent", tenantId: "tenant-a" });
    const row = await pool.query("SELECT created_by, tenant_id FROM tasks WHERE id = $1", [task.id]);
    expect(row.rows[0].created_by).toBe("tenant:tenant-a:tenant-agent");
    expect(row.rows[0].tenant_id).toBe("tenant-a");
  });

  it("list/get 只返回本租户数据，跨租户 get 返回 null", async () => {
    const a = await service.publish({ title: "a", text: "x", createdBy: "x" }, scopeA);
    const b = await service.publish({ title: "b", text: "y", createdBy: "x" }, scopeB);

    const listA = await service.list(scopeA, 50);
    expect(listA.some((r) => r.id === a.id)).toBe(true);
    expect(listA.some((r) => r.id === b.id)).toBe(false);

    expect(await service.get(scopeB, a.id)).toBeNull();
    expect((await service.get(scopeA, a.id))?.id).toBe(a.id);
  });

  it("queries.pending 按租户与角色过滤", async () => {
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, title, text, created_by, assigned_role, status)
       VALUES ('pending-a','tenant-a','pa','x','me','developer','pending'),
              ('pending-b','tenant-b','pb','x','me','developer','pending'),
              ('pending-a2','tenant-a','pa2','x','me','analyst','pending')`,
    );
    const q = new PgTaskQueries(pool);
    const devA = await q.pending({ scope: scopeA, roleId: "developer", limit: 10 });
    expect(devA.map((w) => w.taskId)).toEqual(["pending-a"]);
    expect(devA[0].scope.tenantId).toBe("tenant-a");

    const getCross = await q.get("pending-a", scopeB);
    expect(getCross).toBeNull();
  });
});
