import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { installDefaultRoles } from "../helpers";
import Fastify from "fastify";
import { registerKernelRoutes } from "../../src/pth/gateway/routes-kernel";
import type { KernelRuntime } from "../../src/pth/kernel/assembly";

// 简化 auth：路由测试直接构造 app 并注册 kernel 路由（不含全局 auth hook——auth 已由
// server.ts 的 createAuthHook 统一覆盖，本测试聚焦路由逻辑本身）。
beforeEach(() => installDefaultRoles());

function buildApp(kernel: KernelRuntime | null) {
  const app = Fastify();
  registerKernelRoutes(app, kernel);
  return app;
}

function fakeKernel(overrides: Partial<KernelRuntime> = {}): KernelRuntime {
  return {
    pool: {
      query: async () => ({ rows: [{ status: "pending", n: 2 }, { status: "completed", n: 1 }] }),
    } as any,
    dataWorld: {
      tasks: {
        publish: async (input: any) => ({ id: "t-1", ...input, status: "pending" }),
        candidates: async () => [],
        countPending: async () => 2,
      },
      memory: {} as any,
      transcripts: {} as any,
      audit: {} as any,
    } as any,
    batchManager: {
      spawnBatch: async () => ({ id: "b-1", pid: 100, workers: ["analyst"], currentTasks: new Map(), idleRatio: 1 }),
      killBatch: async () => {},
      listBatches: async () => [{ id: "b-1", pid: 100, workers: ["analyst"], currentTasks: {}, idleRatio: 1 }],
      isBatchAlive: () => true,
    } as any,
    watchdog: {
      getCrashLog: () => [],
      probe: async () => 0,
    } as any,
    shutdown: async () => {},
    ...overrides,
  };
}

describe("kernel routes", () => {
  let app: ReturnType<typeof buildApp>;

  afterAll(async () => {
    if (app) await app.close();
  });

  it("kernel=null → 503", async () => {
    app = buildApp(null);
    const res = await app.inject({ method: "GET", url: "/api/v1/kernel/status" });
    expect(res.statusCode).toBe(503);
  });

  describe("kernel present", () => {
    beforeAll(() => {
      app = buildApp(fakeKernel());
    });

    it("POST /api/v1/kernel/tasks 发布任务 → 201", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { title: "测试", text: "1+1", createdBy: "tester", tags: ["code"] },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBe("t-1");
      expect(body.status).toBe("pending");
    });

    it("POST /api/v1/kernel/tasks 直接发布透传 payload（任务链 flow 声明）", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: {
          title: "链任务", text: "code", createdBy: "tester",
          payload: { flow: { stages: [{ id: "s1", transform: { role: "developer" } }] }, resolvedStages: [] },
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.payload.flow.stages[0].id).toBe("s1");
    });

    it("POST /api/v1/kernel/tasks 缺 title → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { text: "1+1", createdBy: "tester" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("POST /api/v1/kernel/tasks 模板发布（recon-doc）→ 201", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { template: "recon-doc", params: { url: "https://go.dev/ref/spec" }, createdBy: "tester" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.title).toContain("recon-doc");
      expect(body.text).toContain("web.fetchText");
    });

    it("POST /api/v1/kernel/tasks 模板缺必填参数 → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { template: "recon-doc", params: {} },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("url");
    });

    it("POST /api/v1/kernel/tasks 未知模板 → 404", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { template: "nope", params: {} },
      });
      expect(res.statusCode).toBe(404);
    });

    it("GET /api/v1/kernel/templates → 模板列表", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/kernel/templates" });
      expect(res.statusCode).toBe(200);
      const ids = (res.json() as Array<{ id: string }>).map((t) => t.id);
      expect(ids).toContain("recon-doc");
      expect(ids).toContain("memory-maintain");
      expect(ids).toContain("dev-task");
    });

    it("GET /api/v1/kernel/tasks → 任务列表", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/kernel/tasks" });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });

    it("GET /api/v1/kernel/status → 运行状态全景（监控面板铺垫）", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/kernel/status" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.kernel.connected).toBe(true);
      expect(Array.isArray(body.batches)).toBe(true);
      expect(body.tasks.pending).toBe(2);
      expect(Array.isArray(body.watchdog.crashLog)).toBe(true);
    });

    it("POST /api/v1/kernel/batch/add → 启动 batch", async () => {
      const res = await app.inject({ method: "POST", url: "/api/v1/kernel/batch/add", payload: { count: 1 } });
      expect(res.statusCode).toBe(200);
      expect(res.json().spawned).toBe(1);
    });

    it("POST /api/v1/kernel/batch/remove → 停止 batch", async () => {
      const res = await app.inject({ method: "POST", url: "/api/v1/kernel/batch/remove", payload: { count: 1 } });
      expect(res.statusCode).toBe(200);
      expect(res.json().stopped).toBe(1);
    });

    it("GET /api/v1/kernel/batch → batch 列表", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/kernel/batch" });
      expect(res.statusCode).toBe(200);
      expect(res.json()[0].id).toBe("b-1");
    });
  });
});

describe("flow role 路由（body.flow 顶层——发布即路由到指定角色）", () => {
  it("顶层 flow 并入 payload——routeTaskRole 命中显式 role", async () => {
    const { PgTaskStore } = await import("../../src/pth/kernel/storage/task-store-pg.js");
    const { routeTaskRole } = await import("../../src/pth/kernel/execution/role-router.js");
    const { allWorkerRoles } = await import("../../src/pth/kernel/execution/worker-cluster.js");
    const roles = allWorkerRoles();
    // 模拟 routes-kernel 的 payload 构造（body.flow 顶层并入）
    const bodyFlow = { stages: [{ task: { role: "developer" } }] };
    const payload = { ...{}, ...(bodyFlow ? { flow: bodyFlow } : {}) };
    const assigned = routeTaskRole({ id: "test-123", tags: [], payload });
    expect(assigned).toBe("developer");
    expect(roles.some((r) => r.id === assigned)).toBe(true);
  });
});

describe("memory-bridge（ASP-5：sandbox python 空间记忆入口）", () => {
  // H4 修复：不再使用公开默认密钥——测试显式注入（fail-closed）
  const SECRET = "test-secret-12345";
  const visibleMeta = { space: "public", scope: "space" };

  beforeAll(() => { process.env.SANDBOX_SHARED_SECRET = SECRET; });
  afterAll(() => { delete process.env.SANDBOX_SHARED_SECRET; });

  function bridgeApp() {
    return buildApp({
      dataWorld: {
        tasks: { publish: async () => ({}), candidates: async () => [], countPending: async () => 0 } as any,
        memory: {
          retrieve: async ({ anchors, kinds }: any) =>
            anchors.includes("absent") ? [] : [{ id: "m1", kind: kinds[0] ?? "note", meta: visibleMeta }],
          get: async (id: string) => (id === "m1" ? { id: "m1", kind: "note", meta: visibleMeta } : null),
        } as any,
        transcripts: {} as any,
        audit: {} as any,
      } as any,
    });
  }

  it("query：认证失败 → 401", async () => {
    const app = bridgeApp();
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "query", sql: "SELECT 1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("H4：SANDBOX_SHARED_SECRET 未配置（无公开默认值）→ fail-closed 401", async () => {
    const saved = process.env.SANDBOX_SHARED_SECRET;
    delete process.env.SANDBOX_SHARED_SECRET;
    try {
      const app = bridgeApp();
      const res = await app.inject({
        method: "POST", url: "/api/v1/kernel/memory-bridge",
        headers: { authorization: "Bearer sandbox-dev-secret" }, // 旧默认值不得再有效
        payload: { op: "query", sql: "SELECT 1" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      if (saved !== undefined) process.env.SANDBOX_SHARED_SECRET = saved;
    }
  });

  it("query：白名单 SQL 经 queryReadOnly 返回并过滤空间可见性", async () => {
    const calls: string[] = [];
    const app = buildApp({
      dataWorld: {
        tasks: { publish: async () => ({}), candidates: async () => [], countPending: async () => 0 } as any,
        queryReadOnly: async (sql: string) => {
          calls.push(sql);
          // 存量默认 meta+public；private 条目 scope 在别处
          return [
            { meta: { spaceScope: { space: "meta", visibility: "public" } } },
            { meta: { spaceScope: { space: "ts", visibility: "private" } } },
            { meta: undefined },
          ];
        },
        memory: {} as any,
        transcripts: {} as any,
        audit: {} as any,
      } as any,
    });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { op: "query", sql: "SELECT kind FROM memory_entries LIMIT 2", space: "meta" },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toContain("SELECT kind FROM memory_entries");
    // meta 空间可见：meta-public 条目 + 无 meta 存量默认可见；ts-private 条目被滤掉
    expect(res.json()).toHaveLength(2);
  });

  it("get：跨空间不可见 → 404", async () => {
    const app = bridgeApp();
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { op: "get", id: "m1", space: "private-other" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("op 非法 → 400", async () => {
    const app = bridgeApp();
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { op: "write" },
    });
    expect(res.statusCode).toBe(400);
  });
});
