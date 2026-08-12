import { describe, it, expect } from "vitest";
import { AGENT_TOOLS } from "../../src/pth/kernel/execution/agent-tools.js";
import { toolsForExecTool } from "../../src/pth/kernel/execution/agent-tools.js";

/** 生产核 dev 空间（2026-08-11）：工具面族展开 + debug.* handler（debugApi 注入 mock） */
describe("生产核 dev 空间工具面", () => {
  it("dev 族名展开：6 个 dev.* 工具", () => {
    const tools = toolsForExecTool("dev").map((t) => t.name);
    expect(tools).toEqual(["dev_write", "dev_edit", "dev_build", "dev_run", "dev_save", "dev_list"]);
  });

  it("debug 族名展开：8 个 debug.* 工具", () => {
    const tools = toolsForExecTool("debug").map((t) => t.name);
    expect(tools).toEqual([
      "debug_attach", "debug_breakpoint", "debug_continue", "debug_step",
      "debug_snapshot", "debug_evaluate", "debug_detach", "debug_sessions",
    ]);
  });

  it("debug.* handler：debugApi mock 转发（attach→breakpoint→snapshot 聚合）", async () => {
    const calls: Array<{ op: string; body: Record<string, unknown> }> = [];
    // fetch mock：按 op 分发
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const u = String(url);
      const op = u.split("/kernel/debug/")[1];
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      calls.push({ op, body });
      const payload =
        op === "attach" ? { sessionId: "c-debug-test1" }
        : op === "breakpoint" ? { id: "bp-1", line: body.line, verified: true }
        : op === "snapshot" ? { frames: [{ id: 0, name: "main", file: "main.c", line: 6 }], variables: [{ name: "i", value: "1", type: "int" }] }   // 原生 snapshot 单跳（2026-08-12 小缺口）
        : { ok: true };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
    try {
      const ctx = { kernel: {} as never, caps: {}, debugApi: { url: "http://mock:8080", secret: "s" } };
      const a = await AGENT_TOOLS["debug.attach"](ctx, { code: "int main(){return 0;}" });
      expect(a.ok).toBe(true);
      expect((a.value as { sessionId: string }).sessionId).toBe("c-debug-test1");
      const b = await AGENT_TOOLS["debug.breakpoint"](ctx, { sessionId: "c-debug-test1", line: 6 });
      expect(b.ok).toBe(true);
      // snapshot 聚合：原生端点单跳（2026-08-12 小缺口——不再 stack+variables 两次调用）
      const snap = await AGENT_TOOLS["debug.snapshot"](ctx, { sessionId: "c-debug-test1" });
      expect(snap.ok).toBe(true);
      const v = snap.value as { frames: unknown[]; variables: Array<{ name: string }> };
      expect(v.frames).toHaveLength(1);
      expect(v.variables[0].name).toBe("i");
      expect(calls.map((c) => c.op)).toEqual(["attach", "breakpoint", "snapshot"]);
      // 认证头
      expect(calls[0].body.code).toContain("main");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("debug.* handler：sandbox 错误显式透传（session not found 引导重 attach）", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("session not found", { status: 404 })) as typeof fetch;
    try {
      const ctx = { kernel: {} as never, caps: {}, debugApi: { url: "http://mock:8080", secret: "s" } };
      const r = await AGENT_TOOLS["debug.continue"](ctx, { sessionId: "ghost" });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/debug.continue failed \(404\)/);
      expect(r.error).toMatch(/session not found/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("dev.build：buildOnly 透传 kernel.c（编译不运行语义）", async () => {
    const seen: Array<{ code: string; opts: unknown }> = [];
    const fakeKernelC = {
      execute: async (code: string, opts: unknown) => {
        seen.push({ code, opts });
        return { ok: true, value: { binaryRef: "abc123" }, durationMs: 1 };
      },
    };
    const ctx = {
      kernel: { c: fakeKernelC } as never,
      caps: {},
      taskWorkspace: "/tmp",
    };
    // 直接写 fixture 文件
    const { writeFile } = await import("node:fs/promises");
    await writeFile("/tmp/dev-build-test.c", "int main(){return 0;}");
    const r = await AGENT_TOOLS["dev.build"](ctx, { path: "dev-build-test.c" });
    expect(r.ok).toBe(true);
    expect(seen[0].opts).toEqual({ buildOnly: true });
    const { rm } = await import("node:fs/promises");
    await rm("/tmp/dev-build-test.c", { force: true });
  });
});
