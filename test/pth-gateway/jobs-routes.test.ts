import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerJobRoutes } from "../../src/pth/gateway/routes-jobs.js";
import type { KernelRuntime } from "../../src/pth/kernel/assembly";

function buildApp(kernel: KernelRuntime | null) {
  const app = Fastify();
  registerJobRoutes(app, kernel);
  return app;
}

function fakeKernel(): KernelRuntime {
  const rows: Array<Record<string, unknown>> = [];
  return {
    pool: {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes("job_id IS NOT NULL")) {
          return { rows: [{ job_id: "job-1", total: 1, completed: 0, failed: 0, created_at: new Date() }] };
        }
        if (sql.includes("WHERE job_id =")) {
          return { rows };
        }
        if (sql.includes("job_id = ANY")) {
          return { rows: rows.filter((r) => params[0]!.includes(r.id)).map((r) => ({ job_id: r.job_id })) };
        }
        return { rows: [] };
      },
    } as any,
    dataWorld: {
      tasks: {
        publish: async (input: any) => {
          const t = { id: `t-${rows.length + 1}`, ...input, status: "pending" };
          rows.push(t);
          return t;
        },
      },
    } as any,
  } as KernelRuntime;
}

describe("job 路由（异步委托——交互层脱手）", () => {
  it("POST /jobs：批量发布任务 → 立即返回 jobId+taskIds（脱手）", async () => {
    const app = buildApp(fakeKernel());
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/jobs",
      payload: { plan: "计划", tasks: [
        { title: "t1", text: "const a = 1; a;", tags: ["code"] },
        { title: "t2", text: "const b = 2; b;", tags: ["code"] },
      ] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.jobId).toBeTruthy();
    expect(body.taskIds).toHaveLength(2);
    await app.close();
  });

  it("GET /jobs：聚合列表", async () => {
    const app = buildApp(fakeKernel());
    const res = await app.inject({ method: "GET", url: "/api/v1/kernel/jobs" });
    expect(res.statusCode).toBe(200);
    expect(res.json().jobs).toHaveLength(1);
    await app.close();
  });

  it("GET /jobs/:id：任务明细（含产物 outputRef）", async () => {
    const app = buildApp(fakeKernel());
    const post = await app.inject({
      method: "POST", url: "/api/v1/kernel/jobs",
      payload: { tasks: [{ title: "x", text: "const v = 42; v;", tags: ["code"] }] },
    });
    const body = post.json();
    const res = await app.inject({ method: "GET", url: `/api/v1/kernel/jobs/${body.jobId}` });
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.jobId).toBe(body.jobId);
    expect(detail.tasks).toHaveLength(1);
    await app.close();
  });

  it("POST /jobs：空 tasks 拒绝", async () => {
    const app = buildApp(fakeKernel());
    const res = await app.inject({ method: "POST", url: "/api/v1/kernel/jobs", payload: { tasks: [] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
