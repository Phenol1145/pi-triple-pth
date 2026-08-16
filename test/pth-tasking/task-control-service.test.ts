import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool } from "../../src/pth/kernel/storage/pg.js";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import { PgTaskStore } from "../../src/pth/kernel/storage/task-store-pg.js";
import { TaskControlService } from "../../src/pth/tasking/task-control-service.js";
import { PgTaskQueries } from "../../src/pth/tasking/task-queries.js";
import { checkTaskRouting, routeTaskRole } from "../../src/pth/kernel/execution/role-router.js";
import { installDefaultRoles } from "../helpers.js";
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
  let routedStore: PgTaskStore;
  let routedService: TaskControlService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    installDefaultRoles();
    store = new PgTaskStore(pool);
    service = new TaskControlService({ store, pool, queries: new PgTaskQueries(pool) });
    routedStore = new PgTaskStore(pool, { validate: checkTaskRouting, assign: routeTaskRole });
    routedService = new TaskControlService({ store: routedStore, pool, queries: new PgTaskQueries(pool) });
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

  it("W8 P0：外部入口恒盖 entry delivery，body 伪造 delivery 被服务端覆盖", async () => {
    const task = await routedService.publish(
      {
        title: "entry", text: "x", tags: ["code"],
        payload: { delivery: { path: ["forged"], lineageId: "forged" } },
      },
      scopeA,
    );
    expect(task.assigned_role).toBe("developer");
    expect((task.payload as { delivery?: unknown }).delivery).toEqual({
      path: ["developer"],
      lineageId: task.id,
    });
  });

  it("W8 P1：developer→coder delegate 服务端盖章 + await 一次性查询契约", async () => {
    const caller = {
      taskId: "parent-1",
      roleId: "developer",
      tenantId: "tenant-a",
      delivery: { path: ["developer"], lineageId: "root-1" },
    };
    const delegated = await routedService.delegate(
      {
        to: "coder", title: "实现 helper", text: "写一个 helper 并自测",
        tags: ["coding"], expect: "result", context: { spec: "helper.ts" },
        // body 自报投递字段（应被服务端完全忽略）
        ...({ delivery: { path: ["forged"], lineageId: "forged" } } as object),
      },
      caller,
      scopeA,
    );
    expect(delegated).toEqual({ taskId: delegated.taskId, roleId: "coder", path: ["developer", "coder"] });

    const row = await pool.query(
      "SELECT assigned_role, created_by, tags, payload FROM tasks WHERE id = $1",
      [delegated.taskId],
    );
    expect(row.rows[0].assigned_role).toBe("coder");
    expect(row.rows[0].created_by).toBe("worker:developer");
    expect(row.rows[0].tags).toEqual(["coding"]);
    expect(row.rows[0].payload.delivery).toEqual({
      parent: { taskId: "parent-1", roleId: "developer", typePath: ["developer"] },
      path: ["developer", "coder"],
      lineageId: "root-1",
      replyTo: "parent",
    });
    expect(row.rows[0].payload.context).toEqual({ spec: "helper.ts" });
    expect(row.rows[0].payload.expect).toBe("result");

    // P1 await 形态：pending 一次性查询（waiting=true，不挂起不轮询）
    const pending = await routedService.awaitTask({ taskId: delegated.taskId }, caller, scopeA);
    expect(pending).toEqual({ status: "pending", waiting: true, result: null, artifactRef: null });

    // 终态后返回 result（模拟 done 回写——完整 commit 路径已由 pg-task-repository 测试覆盖）
    await pool.query(
      `UPDATE tasks SET status = 'completed',
         payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{result}', '{"value":42}'::jsonb, true)
       WHERE id = $1`,
      [delegated.taskId],
    );
    const done = await routedService.awaitTask({ taskId: delegated.taskId }, caller, scopeA);
    expect(done).toEqual({ status: "completed", result: { value: 42 }, artifactRef: null, summary: undefined });
  });

  it("W8 P1：组织权 fail-fast——违规不进任务池；MID 目标由服务端直接填 assigned_role", async () => {
    const developer = { taskId: "parent-2", roleId: "developer", tenantId: "tenant-a", delivery: { path: ["developer"], lineageId: "root-2" } };
    const before = Number((await pool.query(`SELECT count(*)::int AS n FROM tasks`)).rows[0].n);
    await expect(
      routedService.delegate({ to: "scout", title: "越权", text: "x" }, developer, scopeA),
    ).rejects.toThrow(/组织权拒绝.*developer.*scout/);
    await expect(
      routedService.delegate({ to: "tester", title: "叶子投递", text: "x" }, { ...developer, roleId: "coder" }, scopeA),
    ).rejects.toThrow(/组织权拒绝.*coder.*tester/);
    const after = Number((await pool.query(`SELECT count(*)::int AS n FROM tasks`)).rows[0].n);
    expect(after).toBe(before); // 未进任务池

    // 用户裁决：assigned_role 服务端直接指定——MID（researcher）无已注册标签也可投递
    const actuator = { taskId: "act-1", roleId: "actuator", tenantId: "tenant-a", delivery: { path: ["actuator"], lineageId: "act-root" } };
    const mid = await routedService.delegate({ to: "researcher", title: "研究", text: "深度调研" }, actuator, scopeA);
    expect(mid).toEqual({ taskId: mid.taskId, roleId: "researcher", path: ["actuator", "researcher"] });
    const midRow = await pool.query("SELECT assigned_role, payload FROM tasks WHERE id = $1", [mid.taskId]);
    expect(midRow.rows[0].assigned_role).toBe("researcher");
    expect(midRow.rows[0].payload.delivery.parent.roleId).toBe("actuator");
  });

  it("W8 P1：await 只允许直接子任务；跨任务/跨租户即拒绝", async () => {
    const caller = { taskId: "parent-3", roleId: "developer", tenantId: "tenant-a", delivery: { path: ["developer"], lineageId: "root-3" } };
    const child = await routedService.delegate({ to: "coder", title: "c", text: "x" }, caller, scopeA);
    await expect(
      routedService.awaitTask({ taskId: child.taskId }, { ...caller, taskId: "other-task" }, scopeA),
    ).rejects.toThrow(/不是当前任务的直接子任务/);
    await expect(
      routedService.awaitTask({ taskId: child.taskId }, caller, { ...scopeA, tenantId: "tenant-b" }),
    ).rejects.toThrow(/不存在或不属于当前租户/);
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
    const inserted = devA.filter((w) => w.taskId.startsWith("pending-"));
    expect(inserted.map((w) => w.taskId)).toEqual(["pending-a"]);
    expect(inserted[0].scope.tenantId).toBe("tenant-a");

    const getCross = await q.get("pending-a", scopeB);
    expect(getCross).toBeNull();
  });
});
