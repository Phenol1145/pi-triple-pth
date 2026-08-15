import { describe, it, expect, vi, afterEach } from "vitest";
import { SandboxKernel } from "@away_from/pth-sandbox";

/**
 * SandboxKernel abort 单元测试（A1 Phase 3 条目 11）——fetch stub：
 * acquire 正常返回；execute 永不 resolve（模拟宿主程序跑飞）直到 client abort；
 * release 立即 ok。确定性验证「终止 in-flight + await release 落地」契约。
 */

function stubSandboxFetch(onRelease: () => void) {
  return vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    if (u.endsWith("/kernel/acquire")) {
      return new Response(JSON.stringify({ kernelId: "py-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.endsWith("/kernel/release")) {
      onRelease();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.endsWith("/kernel/execute")) {
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

describe("SandboxKernel——程序级制动（A1 Phase 3 条目 11 abort 契约）", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("abort 终止 in-flight execute → ok:false aborted + release 落地（await）", async () => {
    let released = 0;
    const fn = stubSandboxFetch(() => { released++; });
    vi.stubGlobal("fetch", fn);
    const k = new SandboxKernel({ url: "http://sandbox.test", secret: "s", language: "python", acquireOnInit: false });
    const start = Date.now();
    const p = k.execute("while True: pass", { timeoutMs: 60_000 });
    await vi.waitFor(() => {
      expect(fn.mock.calls.some((c) => String(c[0]).endsWith("/kernel/execute"))).toBe(true);
    });
    await k.abort();
    const r = await p;
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("aborted");
    expect(r.error?.message).toContain("aborted");
    expect(released).toBe(1);   // dispose 归还租约已落地（abort await release）
    expect(elapsed).toBeLessThan(10_000);   // 立即落地而非等 60s timeout
  });

  it("abort 无 in-flight（未 acquire）——安全 no-op（不抛）", async () => {
    const fn = stubSandboxFetch(() => {});
    vi.stubGlobal("fetch", fn);
    const k = new SandboxKernel({ url: "http://sandbox.test", secret: "s", language: "bash", acquireOnInit: false });
    await k.abort();   // dispose 置位（kernelId null——无 release 调用）——不抛即通过
  });
});
