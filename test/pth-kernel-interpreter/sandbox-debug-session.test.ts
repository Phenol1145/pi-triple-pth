import { describe, it, expect, vi } from "vitest";
import { SandboxDebugSession } from "../../src/pth/impls/kernels/sandbox-debug-session.js";

describe("SandboxDebugSession（debug 核 sandbox 适配器）", () => {
  const okJson = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => "" });

  it("attach 创建会话（sessionId 填充 + Bearer + 代码体）", async () => {
    const fetched = vi.fn(async () => okJson({ sessionId: "c-debug-abc" }));
    vi.stubGlobal("fetch", fetched);
    const s = new SandboxDebugSession({ url: "http://s:8080", secret: "sec" });
    await s.attach("int main(){return 0;}");
    expect(s.id).toBe("c-debug-abc");
    const [url, init] = fetched.mock.calls[0]!;
    expect(url).toBe("http://s:8080/kernel/debug/attach");
    expect(init!.headers.authorization).toBe("Bearer sec");
    expect(JSON.parse(init!.body as string).code).toContain("main");
    vi.unstubAllGlobals();
  });

  it("cc 变体透传", async () => {
    const fetched = vi.fn(async () => okJson({ sessionId: "x" }));
    vi.stubGlobal("fetch", fetched);
    const s = new SandboxDebugSession({ url: "http://s:8080", secret: "x", cc: "gcc" });
    await s.attach("int main(){return 0;}");
    expect(JSON.parse(fetched.mock.calls[0]![1]!.body as string).cc).toBe("gcc");
    vi.unstubAllGlobals();
  });

  it("breakpoint/step/evaluate 带 sessionId 转发", async () => {
    const calls: Array<[string, unknown]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push([url, JSON.parse(init.body as string)]);
      return okJson({ id: "bp-5" });
    }));
    const s = new SandboxDebugSession({ url: "http://s:8080", secret: "x", sessionId: "sess-1" });
    await s.setBreakpoint(5);
    await s.step("into");
    await s.evaluate("x + 1");
    expect(calls[0]![0]).toContain("/breakpoint");
    expect(calls[1]![0]).toContain("/step");
    expect(calls[2]![0]).toContain("/evaluate");
    expect((calls[0]![1] as Record<string, unknown>).sessionId).toBe("sess-1");
    vi.unstubAllGlobals();
  });

  it("snapshot 原生聚合端点转发（2026-08-12 小缺口——单跳全帧+变量）", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init.body ?? "{}") });
      return { ok: true, json: async () => ({ frames: [{ id: 0, name: "main", line: 3 }], variables: [{ name: "x", value: "42" }] }) };
    });
    const s = new SandboxDebugSession({ url: "http://x", secret: "k", sessionId: "c-debug-t1" });
    const snap = await s.snapshot();
    expect(snap.frames[0]?.name).toBe("main");
    expect(snap.variables[0]?.value).toBe("42");
    expect(calls[0]?.url).toContain("/kernel/debug/snapshot");
    expect(calls[0]?.body).toMatchObject({ sessionId: "c-debug-t1" });
  });

  it("HTTP 非 2xx → 抛错（含状态码）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "session not found" })));
    const s = new SandboxDebugSession({ url: "http://s:8080", secret: "x", sessionId: "gone" });
    await expect(s.continueExec()).rejects.toThrow("404");
    vi.unstubAllGlobals();
  });

  it("body.error 字段 → 抛错（gdb 层错误透传）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ error: "gdb 命令超时" })));
    const s = new SandboxDebugSession({ url: "http://s:8080", secret: "x", sessionId: "s1" });
    await expect(s.continueExec()).rejects.toThrow("gdb 命令超时");
    vi.unstubAllGlobals();
  });

  it("detach 清 sessionId（幂等）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ ok: true })));
    const s = new SandboxDebugSession({ url: "http://s:8080", secret: "x", sessionId: "s1" });
    await s.detach();
    expect(s.id).toBe("");
    await s.detach();   // 幂等
    vi.unstubAllGlobals();
  });
});
