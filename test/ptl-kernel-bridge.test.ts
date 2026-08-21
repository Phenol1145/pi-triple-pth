import { describe, it, expect, vi, afterEach } from "vitest";
import { PthClient } from "../packages/pth-console/src/bridge/client.js";

// mock global fetch：记录请求，返回可配置响应
function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const r = handler(url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  }));
}

function makeClient(): PthClient {
  return new PthClient("http://pth:3000", "tok");
}

afterEach(() => vi.unstubAllGlobals());

describe("PthClient kernel 方法", () => {
  it("publishTask POST /api/v1/kernel/tasks 带 Bearer + JSON", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    mockFetch((url, init) => {
      calls.push({ url, init });
      return { status: 201, body: { id: "t-1", status: "pending" } };
    });
    const c = makeClient();
    const res = await c.publishTask({ title: "t", text: "1+1", createdBy: "me", tags: ["code"] });
    expect(res.id).toBe("t-1");
    const call = calls[0];
    expect(call.url).toBe("http://pth:3000/api/v1/kernel/tasks");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(call.init.body as string)).toMatchObject({ title: "t", text: "1+1", createdBy: "me", tags: ["code"] });
  });

  it("listTasks GET /api/v1/kernel/tasks", async () => {
    const calls: Array<{ url: string }> = [];
    mockFetch((url, init) => {
      calls.push({ url });
      return { status: 200, body: [{ id: "t-1", status: "completed" }] };
    });
    const c = makeClient();
    const res = await c.listTasks({ limit: 10 });
    expect(res).toHaveLength(1);
    expect(calls[0].url).toContain("/api/v1/kernel/tasks?limit=10");
  });

  it("batchAdd POST /api/v1/kernel/batch/add", async () => {
    mockFetch((url, init) => {
      expect(JSON.parse(init.body as string)).toEqual({ count: 2 });
      return { status: 200, body: { spawned: 2 } };
    });
    const c = makeClient();
    const res = await c.batchAdd(2);
    expect(res.spawned).toBe(2);
  });

  it("kernelStatus GET /api/v1/kernel/status 返回全景", async () => {
    mockFetch((_url) => ({
      status: 200,
      body: { kernel: { connected: true }, batches: [], tasks: { pending: 3, total: 3 }, watchdog: { crashLog: [] }, collectedAt: 1 },
    }));
    const c = makeClient();
    const res = await c.kernelStatus();
    expect(res.kernel.connected).toBe(true);
    expect(res.tasks.pending).toBe(3);
  });
});
