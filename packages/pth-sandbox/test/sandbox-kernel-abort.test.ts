import { describe, it, expect, vi, afterEach } from "vitest";
import { SandboxKernel, createSandboxGrantIssuer } from "@away_from/pth-sandbox";

/**
 * SandboxKernel abort 单元测试（P4 会话语义，2026-08-22）——fetch stub：
 * 会话创建正常返回；execute 永不 resolve（模拟宿主程序跑飞）直到 client abort。
 * 裁决：abort 后本地 session 作废且**不 release**（池条目绝不乐观复用，pool TTL 兜底回收）。
 */

const grantIssuer = createSandboxGrantIssuer({ secret: "abort-grant-secret-0123456789" });
function makeGrant() {
  return grantIssuer.issue({
    lease: { taskId: "task-abort", leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6", generation: 1 },
    scope: { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-abort" },
    workspace: { tenantId: "tenant-a", workspaceId: "ws-abort", taskId: "task-abort" },
    language: "python",
    capabilities: ["memory.read"],
  });
}

function stubSandboxFetch() {
  return vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    if (u.endsWith("/sessions")) {
      return new Response(JSON.stringify({ sessionId: "4f5e3f44-ec85-4e83-9c99-2d17d343d0e1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.endsWith("/execute")) {
      // 模拟宿主执行跑飞：永不 resolve，直到 client abort（AbortError——undici 语义）
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("This operation was aborted."), { name: "AbortError" }));
        });
      });
    }
    return new Response(JSON.stringify({ error: "unknown path" }), { status: 404 });
  });
}

describe("SandboxKernel——程序级制动（P4 会话 abort 契约）", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("abort 终止 in-flight execute → ok:false aborted，不 release（安全作废，pool TTL 兜底）", async () => {
    const fn = stubSandboxFetch();
    vi.stubGlobal("fetch", fn);
    const k = new SandboxKernel({ url: "http://sandbox.test", secret: "s", language: "python", acquireOnInit: false, grant: makeGrant() });
    const start = Date.now();
    const p = k.execute("while True: pass", { timeoutMs: 60_000 });
    await vi.waitFor(() => {
      expect(fn.mock.calls.some((c) => String(c[0]).endsWith("/execute"))).toBe(true);
    });
    await k.abort();
    const r = await p;
    expect(fn.mock.calls.some((c) => String(c[0]).endsWith("/release"))).toBe(false); // 绝不乐观归还
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("aborted");
    expect(r.error?.message).toContain("aborted");
    expect(elapsed).toBeLessThan(10_000); // 立即落地而非等 60s timeout
  });

  it("abort 无 in-flight（未创建会话）——安全 no-op（不抛）", async () => {
    const fn = stubSandboxFetch();
    vi.stubGlobal("fetch", fn);
    const k = new SandboxKernel({ url: "http://sandbox.test", secret: "s", language: "bash", acquireOnInit: false });
    await k.abort(); // disposed 置位（sessionId null——无 release 调用）——不抛即通过
  });
});
