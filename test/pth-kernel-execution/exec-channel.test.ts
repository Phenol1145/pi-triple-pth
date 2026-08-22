import { describe, it, expect, vi } from "vitest";
import { KernelExecChannel } from "../../src/pth/kernel/exec-channel.js";

/** 假 kernel 工厂（真实装配走 sandbox/python——单测只验通道行为） */
function fakeKernelFactory(calls: { n: number }) {
  const contexts: Array<Map<string, unknown>> = [];
  return async () => {
    calls.n++;
    const ctx = new Map<string, unknown>();
    contexts.push(ctx);
    return {
      ts: {
        execute: async (code: string, _opts?: unknown) => {
          if (code.includes("THROW")) return { ok: false, error: { message: "boom" }, durationMs: 1 };
          // 极简 REPL 语义模拟：let x = N 存值；x 取值
          const m = code.match(/^let (\w+) = (\d+)$/);
          if (m) { ctx.set(m[1]!, Number(m[2])); return { ok: true, value: Number(m[2]), durationMs: 1 }; }
          if (ctx.has(code.trim())) return { ok: true, value: ctx.get(code.trim()), durationMs: 1 };
          return { ok: true, value: code, durationMs: 1 };
        },
      },
      dispose: () => {},
    } as never;
  };
}

describe("KernelExecChannel（kernel 直连通道——任务池纯化 D2）", () => {
  it("stateless：每次独立 context（状态不保留）", async () => {
    const calls = { n: 0 };
    const ch = new KernelExecChannel({ dataWorld: {} as never, kernelFactory: fakeKernelFactory(calls) });
    await ch.execute({ code: "let x = 42" });
    const r2 = await ch.execute({ code: "x" });
    expect(calls.n).toBe(2);              // 每次新建 kernel
    expect(r2.value).toBe("x");           // 第二次拿不到 x（回显原码——独立 context）
    expect(r2.mode).toBe("stateless");
    await ch.shutdown();
  });

  it("repl：sessionId 持久 context（跨调用状态保留）", async () => {
    const calls = { n: 0 };
    const ch = new KernelExecChannel({ dataWorld: {} as never, kernelFactory: fakeKernelFactory(calls) });
    const r1 = await ch.execute({ code: "let x = 42", mode: "repl" });
    expect(r1.sessionId).toBeTruthy();    // 缺省新建并返回 id
    const r2 = await ch.execute({ code: "x", mode: "repl", sessionId: r1.sessionId });
    expect(r2.value).toBe(42);            // 同 session 拿到上次的 x
    expect(calls.n).toBe(1);              // kernel 复用
    expect(ch.sessionCount).toBe(1);
    await ch.shutdown();
  });

  it("repl：不同 sessionId 状态隔离", async () => {
    const ch = new KernelExecChannel({ dataWorld: {} as never, kernelFactory: fakeKernelFactory({ n: 0 }) });
    const a = await ch.execute({ code: "let x = 1", mode: "repl" });
    const b = await ch.execute({ code: "let x = 2", mode: "repl" });
    expect(a.sessionId).not.toBe(b.sessionId);
    const ra = await ch.execute({ code: "x", mode: "repl", sessionId: a.sessionId });
    const rb = await ch.execute({ code: "x", mode: "repl", sessionId: b.sessionId });
    expect(ra.value).toBe(1);
    expect(rb.value).toBe(2);
    await ch.shutdown();
  });

  it("执行失败：ok:false + error 透传（不抛）", async () => {
    const ch = new KernelExecChannel({ dataWorld: {} as never, kernelFactory: fakeKernelFactory({ n: 0 }) });
    const r = await ch.execute({ code: "THROW" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("boom");
    await ch.shutdown();
  });

  it("notebook cell 门禁：语言白名单 + 非空 code（fail-closed）", async () => {
    const ch = new KernelExecChannel({ dataWorld: {} as never });
    await expect(ch.executeNotebookCell({ language: "ruby" as never, code: "1" })).rejects.toThrow(/unsupported notebook language/);
    await expect(ch.executeNotebookCell({ language: "python", code: "" })).rejects.toThrow(/notebook code required/);
    await ch.shutdown();
  });

  it("idle TTL 回收：超时 session 被清理", async () => {
    vi.useFakeTimers();
    try {
      const ch = new KernelExecChannel({ dataWorld: {} as never, kernelFactory: fakeKernelFactory({ n: 0 }), sessionTtlMs: 1000, sweepMs: 100 });
      const r1 = await ch.execute({ code: "let x = 1", mode: "repl" });
      expect(ch.sessionCount).toBe(1);
      vi.advanceTimersByTime(2000);       // 超 TTL + 多次扫描
      expect(ch.sessionCount).toBe(0);
      // 同 sessionId 再来 → 新建（状态已丢）
      const r2 = await ch.execute({ code: "x", mode: "repl", sessionId: r1.sessionId });
      expect(r2.value).toBe("x");
      await ch.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
