import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { registerKernelRoutes } from "../../src/pth/gateway/routes-kernel";
import type { KernelRuntime } from "../../src/pth/kernel/assembly";

// 简化 auth：路由测试直接构造 app 并注册 kernel 路由（不含全局 auth hook——auth 已由
// server.ts 的 createAuthHook 统一覆盖，本测试聚焦路由逻辑本身）。
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
