import { describe, it, expect, vi } from "vitest";
import { SandboxCompiledKernel } from "../../src/pth/impls/kernels/sandbox-compiled-kernel.js";

describe("SandboxCompiledKernel（编译核 sandbox 适配器）", () => {
  it("execute 转发 /kernel/compiled（Bearer 认证 + 代码体）", async () => {
    const fetched = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: "sum=500500\n", durationMs: 42 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetched);
    const k = new SandboxCompiledKernel({ url: "http://sandbox:8080", secret: "s3cret" });
    const r = await k.execute("#include <stdio.h>\nint main(){return 0;}");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("sum=500500\n");
    const [url, init] = fetched.mock.calls[0]!;
    expect(url).toBe("http://sandbox:8080/kernel/compiled");
    expect(init!.headers.authorization).toBe("Bearer s3cret");
    const body = JSON.parse(init!.body as string);
    expect(body.code).toContain("main");
    vi.unstubAllGlobals();
  });

  it("cc 变体透传（gcc）", async () => {
    const fetched = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: "" }), text: async () => "" }));
    vi.stubGlobal("fetch", fetched);
    const k = new SandboxCompiledKernel({ url: "http://s:8080", secret: "x", cc: "gcc" });
    await k.execute("int main(){return 0;}");
    expect(JSON.parse(fetched.mock.calls[0]![1]!.body as string).cc).toBe("gcc");
    vi.unstubAllGlobals();
  });

  it("HTTP 非 2xx → 错误结果（含状态码）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => "code required" })));
    const k = new SandboxCompiledKernel({ url: "http://s:8080", secret: "x" });
    const r = await k.execute("int main(){return 0;}");
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("400");
    vi.unstubAllGlobals();
  });

  it("fetch 抛错（sandbox 不可达）→ 错误结果", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));
    const k = new SandboxCompiledKernel({ url: "http://s:8080", secret: "x" });
    const r = await k.execute("int main(){return 0;}");
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("fetch failed");
    vi.unstubAllGlobals();
  });

  it("无 sandbox 配置时 manager 侧降级（c 不可用明确错误）", async () => {
    const { createKernelManager } = await import("../../src/pth/impls/kernels/kernel-manager.js");
    const mgr = createKernelManager({
      pythonMode: "kernel", bashMode: "kernel",
      kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" },
      // 无 sandboxKernel → c 降级
    } as any);
    const r = await mgr.execute("c", "int main(){return 0;}");
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("sandbox 未配置");
  });
});
