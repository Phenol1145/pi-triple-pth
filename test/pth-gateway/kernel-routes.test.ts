import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { installDefaultRoles } from "../helpers";
import Fastify from "fastify";
import { registerKernelRoutes } from "../../src/pth/gateway/routes-kernel";
import { createPthGatewayFacade, type PthGatewayFacade } from "../../src/pth/application/gateway/pth-gateway-facade.js";
import type { KernelRuntime } from "../../src/pth/kernel/assembly";

// 简化 auth：路由测试直接构造 app 并注册 kernel 路由（不含全局 auth hook——auth 已由
// server.ts 的 createAuthHook 统一覆盖，本测试聚焦路由逻辑本身）。
beforeEach(() => installDefaultRoles());

function wrap(kernel: unknown): PthGatewayFacade {
  return createPthGatewayFacade(kernel as KernelRuntime);
}

function buildApp(kernel: KernelRuntime | null) {
  const app = Fastify();
  registerKernelRoutes(app, kernel ? wrap(kernel) : null);
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

    it("POST /api/v1/kernel/tasks 透传顶层 domains（字符串数组）", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { title: "测试", text: "1+1", createdBy: "tester", tags: ["code"], domains: ["mathematics", "statistics"] },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().domains).toEqual(["mathematics", "statistics"]);
    });

    it("POST /api/v1/kernel/tasks domains 非字符串数组 → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { title: "测试", text: "1+1", createdBy: "tester", domains: ["ok", 7] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("domains");
    });

    it("POST /api/v1/kernel/tasks domains 元素为空字符串 → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { title: "测试", text: "1+1", createdBy: "tester", domains: ["ok", "  "] },
      });
      expect(res.statusCode).toBe(400);
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
      expect(ids).not.toContain("memory-sweep");   // hidden 系统内部模板不外显（模板统一收口 A+）
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

    it("POST /api/v1/kernel/tasks/:id/cancel → 取消并支持递归传播（W8 P2）", async () => {
      const cancelApp = buildApp(fakeKernel({
        pool: {
          query: async (sql: string) => ({
            rows: sql.startsWith("UPDATE") ? [{ id: "t-1" }] : [{ id: "t-1" }],
            rowCount: sql.startsWith("UPDATE") ? 1 : 1,
          }),
        } as any,
      }));
      const res = await cancelApp.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks/t-1/cancel",
        payload: { recursive: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ cancelled: 1, taskIds: ["t-1"] });
      await cancelApp.close();
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

describe("memory-bridge（P0-1：Bearer 鉴权 + token 声明 space）", () => {
  const visibleMeta = { spaceScope: { space: "public", visibility: "public" } };

  function bridgeApp(auth?: { tenantId?: string; role?: string; space?: string }) {
    const app = Fastify();
    if (auth) {
      app.addHook("onRequest", async (req) => {
        (req as unknown as { auth: unknown }).auth = auth;
      });
    }
    registerKernelRoutes(app, wrap({
      dataWorld: {
        tasks: { publish: async () => ({}), candidates: async () => [], countPending: async () => 0 } as any,
        queryReadOnly: async () => [
          { meta: { spaceScope: { space: "meta", visibility: "public" } } },
          { meta: { spaceScope: { space: "ts", visibility: "private" } } },
        ],
        memory: {
          retrieve: async ({ anchors }: any) =>
            anchors.includes("absent") ? [] : [{ id: "m1", kind: "note", meta: visibleMeta }],
          get: async (id: string) => (id === "m1" ? { id: "m1", kind: "note", meta: visibleMeta } : null),
        } as any,
        transcripts: {} as any,
        audit: {} as any,
      } as any,
    }));
    return app;
  }

  it("无全局 auth hook（未认证）→ 401；旧 SANDBOX_SHARED_SECRET 不再有效", async () => {
    const app = bridgeApp();
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      headers: { authorization: "Bearer sandbox-dev-secret" },
      payload: { op: "query", sql: "SELECT 1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("token 无 space 声明 → 401（fail-closed）", async () => {
    const app = bridgeApp({ tenantId: "tenant-a", role: "tenant-agent" });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "retrieve", anchors: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("body 自报 space → 400（space 只能来自 auth token）", async () => {
    const app = bridgeApp({ tenantId: "tenant-a", role: "tenant-agent", space: "meta" });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "get", id: "m1", space: "meta" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("query：按 token space 过滤可见性，缺 meta 行 fail-closed", async () => {
    const app = bridgeApp({ tenantId: "tenant-a", role: "tenant-agent", space: "meta" });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "query", sql: "SELECT kind, meta FROM memory_entries LIMIT 3" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1); // 仅 meta-public 可见；无 meta 行直接 400
  });

  it("query：缺 meta 行 → 400", async () => {
    const app = Fastify();
    app.addHook("onRequest", async (req) => {
      (req as unknown as { auth: unknown }).auth = { tenantId: "tenant-a", role: "tenant-agent", space: "meta" };
    });
    registerKernelRoutes(app, wrap({
      dataWorld: {
        tasks: { publish: async () => ({}), candidates: async () => [], countPending: async () => 0 } as any,
        queryReadOnly: async () => [{ value: 1 }],
        memory: {} as any,
        transcripts: {} as any,
        audit: {} as any,
      } as any,
    }));
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "query", sql: "SELECT 1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("get：跨空间不可见 → 404", async () => {
    const app = bridgeApp({ tenantId: "tenant-a", role: "tenant-agent", space: "private-other" });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "get", id: "m1" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("retrieve：按 token space 过滤可见性", async () => {
    const app = bridgeApp({ tenantId: "tenant-a", role: "tenant-agent", space: "public" });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "retrieve", anchors: ["a"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it("op 非法 → 400", async () => {
    const app = bridgeApp({ tenantId: "tenant-a", role: "tenant-agent", space: "meta" });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "write" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("P0-3：任务发布的 tenant 只来自 auth token", () => {
  it("publish 携带 req.auth.tenantId，body.tenant 无效", async () => {
    const published: unknown[] = [];
    const app = Fastify();
    app.addHook("onRequest", async (req) => {
      (req as unknown as { auth: unknown }).auth = { tenantId: "tenant-b", role: "tenant-agent" };
    });
    registerKernelRoutes(app, wrap({
      dataWorld: {
        tasks: {
          publish: async (input: Record<string, unknown>) => {
            published.push(input);
            return { id: "t-tenant", status: "pending", ...input };
          },
          candidates: async () => [],
          countPending: async () => 0,
        } as any,
        memory: {} as any,
        transcripts: {} as any,
        audit: {} as any,
      } as any,
      pool: { query: async () => ({ rows: [] }) } as any,
      batchManager: {
        listBatches: async () => [],
        isBatchAlive: () => false,
      } as any,
      watchdog: { getCrashLog: () => [] } as any,
      shutdown: async () => {},
    }));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/tasks",
      payload: { title: "t", text: "x", createdBy: "user", tenant: "tenant-forged" },
    });
    expect(res.statusCode).toBe(201);
    expect(published[0]).toMatchObject({ tenantId: "tenant-b" });
    expect(published[0]).not.toMatchObject({ tenant: "tenant-forged" });
  });
});
