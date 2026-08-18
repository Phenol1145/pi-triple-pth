import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool } from "../../src/pth/kernel/storage/pg.js";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import { PgTaskStore } from "../../src/pth/kernel/storage/task-store-pg.js";
import { TaskControlService, TaskAwaitSuspendedError } from "../../src/pth/tasking/task-control-service.js";
import { PgTaskQueries } from "../../src/pth/tasking/task-queries.js";
import { readWorkItemDomainBinding, readWorkItemDomains } from "../../src/pth/tasking/task-work-item-reader.js";
import { createPgTaskRepository } from "../../src/pth/tasking/adapters/pg-task-repository.js";
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

  it("W8 P1/P2：developer→coder delegate 盖章 + await 挂起登记 + 终态回流契约", async () => {
    // 父任务行必须存在（await 挂起登记写回其 payload.dispatchWait）
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, title, text, created_by, assigned_role, status)
       VALUES ('parent-1','tenant-a','parent','x','worker:developer','developer','claimed')`,
    );
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

    // P2 await 形态：未终态 → 写 dispatchWait[childId] + 抛挂起信号（runner 落 retryable requeue）
    await expect(
      routedService.awaitTask({ taskId: delegated.taskId }, caller, scopeA),
    ).rejects.toBeInstanceOf(TaskAwaitSuspendedError);
    await expect(
      routedService.awaitTask({ taskId: delegated.taskId }, caller, scopeA),
    ).rejects.toMatchObject({ code: "task-await-suspended", childTaskId: delegated.taskId });
    const waitRow = await pool.query(
      `SELECT payload->'dispatchWait'->$2 AS wait FROM tasks WHERE id = $1`,
      [caller.taskId, delegated.taskId],
    );
    expect(waitRow.rows[0].wait).toMatchObject({ at: expect.any(String) });

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

  it("F3：root publish（domains A,B）→ claim reader 盖章 → delegate 完整继承 domains+binding", async () => {
    // 模拟 root publish 已把 domains/domainBinding 写入 payload；claim 侧由
    // task-loop stampTaskDispatchContext 复用 reader 盖章——这里按同一路径构造 caller。
    const bindingAB = {
      matches: [
        { domainId: "mathematics", confidence: 0.9, evidence: ["title math"] },
        { domainId: "statistics", confidence: 0.8, evidence: ["tag stats"] },
      ],
      primaryDomain: "mathematics",
      catalogVersion: "v1",
      resolverVersion: "v1",
    };
    const rootPayload = { domains: ["mathematics", "statistics"], domainBinding: bindingAB };
    const domains = readWorkItemDomains(rootPayload);
    const domainBinding = readWorkItemDomainBinding(rootPayload, domains);
    expect(domains).toEqual(["mathematics", "statistics"]);
    expect(domainBinding).toEqual(bindingAB);

    const caller = {
      taskId: "parent-domains",
      roleId: "developer",
      tenantId: "tenant-a",
      delivery: { path: ["developer"], lineageId: "parent-domains" },
      domains,
      ...(domainBinding ? { domainBinding } : {}),
    };
    const child = await routedService.delegate({ to: "coder", title: "实现", text: "x" }, caller, scopeA);
    const row = await pool.query("SELECT payload FROM tasks WHERE id = $1", [child.taskId]);
    expect(row.rows[0].payload.domains).toEqual(["mathematics", "statistics"]);
    expect(row.rows[0].payload.domainBinding).toEqual(bindingAB);
  });

  it("F3：delegate 显式子集 [A] 成功；越权子集 [C] 拒绝；legacy 父任务 → 子 domains=[]", async () => {
    const caller = {
      taskId: "parent-subset",
      roleId: "developer",
      tenantId: "tenant-a",
      delivery: { path: ["developer"], lineageId: "parent-subset" },
      domains: ["mathematics", "statistics"],
    };

    const subset = await routedService.delegate(
      { to: "coder", title: "子集收窄", text: "x", domains: ["mathematics"] },
      caller,
      scopeA,
    );
    const subsetRow = await pool.query("SELECT payload FROM tasks WHERE id = $1", [subset.taskId]);
    expect(subsetRow.rows[0].payload.domains).toEqual(["mathematics"]);

    const before = Number((await pool.query(`SELECT count(*)::int AS n FROM tasks`)).rows[0].n);
    await expect(
      routedService.delegate(
        { to: "coder", title: "越权子集", text: "x", domains: ["physics"] },
        caller,
        scopeA,
      ),
    ).rejects.toThrow(/domains.*子集/);
    const after = Number((await pool.query(`SELECT count(*)::int AS n FROM tasks`)).rows[0].n);
    expect(after).toBe(before); // 未进任务池

    const legacy = { taskId: "parent-legacy", roleId: "developer", tenantId: "tenant-a", delivery: { path: ["developer"], lineageId: "parent-legacy" } };
    const child = await routedService.delegate({ to: "coder", title: "legacy 父任务", text: "x" }, legacy, scopeA);
    const legacyRow = await pool.query("SELECT payload FROM tasks WHERE id = $1", [child.taskId]);
    expect(legacyRow.rows[0].payload.domains).toEqual([]);
    expect(legacyRow.rows[0].payload.domainBinding).toBeUndefined();
  });

  it("publish(A,B) → delegate(A) → claim keeps binding with only A", async () => {
    // root publish 已把 domains/domainBinding 写入 payload（A,B）；claim 侧由 reader 盖章后，
    // delegate 显式子集 [A] 必须把 binding 裁剪为 only A——claim reader 不再因 B 丢弃整个 binding。
    const bindingAB = {
      matches: [
        { domainId: "mathematics", confidence: 0.9, evidence: ["title math"] },
        { domainId: "statistics", confidence: 0.8, evidence: ["tag stats"] },
      ],
      primaryDomain: "mathematics",
      catalogVersion: "v1",
      resolverVersion: "v1",
    };
    const rootPayload = { domains: ["mathematics", "statistics"], domainBinding: bindingAB };
    const domains = readWorkItemDomains(rootPayload);
    const domainBinding = readWorkItemDomainBinding(rootPayload, domains);
    expect(domainBinding).toEqual(bindingAB);

    const caller = {
      taskId: "parent-claim-subset",
      roleId: "developer",
      tenantId: "tenant-a",
      delivery: { path: ["developer"], lineageId: "parent-claim-subset" },
      domains,
      ...(domainBinding ? { domainBinding } : {}),
    };
    const child = await routedService.delegate(
      { to: "coder", title: "claim subset", text: "x", domains: ["mathematics"] },
      caller,
      scopeA,
    );

    const taskRepository = createPgTaskRepository(pool);
    const claimed = await taskRepository.claim(
      { tenantId: "tenant-a", principalId: "worker:coder", roles: ["coder"], traceId: "claim-subset" },
      "coder",
      [child.taskId],
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.work.domains).toEqual(["mathematics"]);
    expect(claimed[0]!.work.domainBinding).toEqual({
      matches: [{ domainId: "mathematics", confidence: 0.9, evidence: ["title math"] }],
      primaryDomain: "mathematics",
      catalogVersion: "v1",
      resolverVersion: "v1",
    });
  });

  it("delegate(subset) preserves catalogVersion/resolverVersion and primaryDomain order", async () => {
    const bindingAB = {
      matches: [
        { domainId: "mathematics", confidence: 0.9, evidence: ["title math"] },
        { domainId: "statistics", confidence: 0.8, evidence: ["tag stats"] },
      ],
      primaryDomain: "statistics",
      catalogVersion: "v2",
      resolverVersion: "v3",
    };
    const caller = {
      taskId: "parent-preserve-binding",
      roleId: "developer",
      tenantId: "tenant-a",
      delivery: { path: ["developer"], lineageId: "parent-preserve-binding" },
      domains: ["mathematics", "statistics"],
      domainBinding: bindingAB,
    };

    // 子集 [statistics]：primary 仍保留父 primary（statistics 在保留集中）→ 取父 primary。
    const keepPrimary = await routedService.delegate(
      { to: "coder", title: "preserve binding", text: "x", domains: ["statistics"] },
      caller,
      scopeA,
    );
    const keepRow = await pool.query("SELECT payload FROM tasks WHERE id = $1", [keepPrimary.taskId]);
    expect(keepRow.rows[0].payload.domains).toEqual(["statistics"]);
    expect(keepRow.rows[0].payload.domainBinding).toEqual({
      matches: [{ domainId: "statistics", confidence: 0.8, evidence: ["tag stats"] }],
      primaryDomain: "statistics",
      catalogVersion: "v2",
      resolverVersion: "v3",
    });

    // 子集 [mathematics]：父 primary 不在保留集 → 取父 matches 顺序中第一个保留项。
    const fallbackPrimary = await routedService.delegate(
      { to: "coder", title: "preserve binding fallback", text: "x", domains: ["mathematics"] },
      caller,
      scopeA,
    );
    const fallbackRow = await pool.query("SELECT payload FROM tasks WHERE id = $1", [fallbackPrimary.taskId]);
    expect(fallbackRow.rows[0].payload.domains).toEqual(["mathematics"]);
    expect(fallbackRow.rows[0].payload.domainBinding).toEqual({
      matches: [{ domainId: "mathematics", confidence: 0.9, evidence: ["title math"] }],
      primaryDomain: "mathematics",
      catalogVersion: "v2",
      resolverVersion: "v3",
    });
  });

  it("delegate(empty subset or overreach) rejected", async () => {
    const caller = {
      taskId: "parent-empty-subset",
      roleId: "developer",
      tenantId: "tenant-a",
      delivery: { path: ["developer"], lineageId: "parent-empty-subset" },
      domains: ["mathematics", "statistics"],
    };

    // 空子集：显式 domains=[] 拒绝（不产出空 binding）。
    await expect(
      routedService.delegate({ to: "coder", title: "empty subset", text: "x", domains: [] }, caller, scopeA),
    ).rejects.toThrow(/domains.*子集/);

    const before = Number((await pool.query(`SELECT count(*)::int AS n FROM tasks`)).rows[0].n);
    await expect(
      routedService.delegate({ to: "coder", title: "overreach subset", text: "x", domains: ["physics"] }, caller, scopeA),
    ).rejects.toThrow(/domains.*子集/);
    const after = Number((await pool.query(`SELECT count(*)::int AS n FROM tasks`)).rows[0].n);
    expect(after).toBe(before);
  });

  it("F3：delegate domains 非法形状 → PtcContractError", async () => {
    const caller = {
      taskId: "parent-bad-domains",
      roleId: "developer",
      tenantId: "tenant-a",
      delivery: { path: ["developer"], lineageId: "parent-bad-domains" },
      domains: ["mathematics"],
    };
    await expect(
      routedService.delegate({ to: "coder", title: "bad", text: "x", domains: ["mathematics", ""] }, caller, scopeA),
    ).rejects.toThrow(/domains.*字符串数组/);
    await expect(
      routedService.delegate({ to: "coder", title: "bad", text: "x", domains: "mathematics" as unknown as string[] }, caller, scopeA),
    ).rejects.toThrow(/domains.*字符串数组/);
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

  it("W8 P2：取消传播——recursive 沿 delivery.parent 链取消全部未终态子任务", async () => {
    // 父→子→孙 三层派发树（父任务用真实行——delegate 需服务端身份）
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, title, text, created_by, assigned_role, status)
       VALUES ('cancel-root','tenant-a','root','x','worker:developer','developer','claimed')`,
    );
    const rootCaller = { taskId: "cancel-root", roleId: "developer", tenantId: "tenant-a", delivery: { path: ["developer"], lineageId: "cancel-root" } };
    const child = await routedService.delegate({ to: "coder", title: "c", text: "x" }, rootCaller, scopeA);
    // 孙任务直接插入（模拟已有派发树——避免经服务端再走一次合法 delegate）
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, title, text, created_by, assigned_role, status, payload)
       VALUES ('grand-of-cancel','tenant-a','grand','x','worker:tester','tester','pending',
         jsonb_build_object('delivery', jsonb_build_object(
           'parent', jsonb_build_object('taskId', $1::text, 'roleId', 'coder', 'typePath', '["developer","coder"]'::jsonb),
           'path', '["developer","coder","tester"]'::jsonb,
           'lineageId', 'cancel-root')))`,
      [child.taskId],
    );

    // 非递归：只取消根，子/孙不动
    const single = await routedService.cancel("cancel-root", scopeA, { recursive: false });
    expect(single.cancelled).toBe(1);
    expect(single.taskIds).toEqual(["cancel-root"]);
    let childRow = await pool.query("SELECT status FROM tasks WHERE id = $1", [child.taskId]);
    expect(childRow.rows[0].status).toBe("pending");

    // 根已终态 → 递归取消剩余未终态子孙
    const all = await routedService.cancel("cancel-root", scopeA, { recursive: true });
    expect(all.cancelled).toBe(2);
    expect(all.taskIds.sort()).toEqual([child.taskId, "grand-of-cancel"].sort());
    for (const id of [child.taskId, "grand-of-cancel"]) {
      const r = await pool.query("SELECT status, payload->'result'->'error'->>'code' AS code FROM tasks WHERE id = $1", [id]);
      expect(r.rows[0].status).toBe("rejected");
      expect(r.rows[0].code).toBe("cancelled");
    }
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
