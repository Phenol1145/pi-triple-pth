import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { buildKernelHostApp } from "../../src/sandbox/kernel-host.js";
import { SandboxKernel } from "../../src/pth/kernel/interpreter/sandbox-kernel.js";

/**
 * SandboxKernel 适配器集成测试——真实 HTTP（fastify listen :0）+ 真实 python/bash。
 */

const SECRET = "test-sandbox-secret";

describe("SandboxKernel（PTH 侧适配器 → 宿主）", () => {
  let host: any;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.SANDBOX_SHARED_SECRET = SECRET;
    host = buildKernelHostApp({});
    await host.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${host.server.address().port}`;
  });

  afterAll(async () => {
    await host.close();
    delete process.env.SANDBOX_SHARED_SECRET;
  });

  it("python：execute 全链路（懒 acquire → 执行 → value）", async () => {
    const k = new SandboxKernel({ url: baseUrl, secret: SECRET, language: "python" });
    const r = await k.execute("squares = [i*i for i in range(5)]\n_result = sum(squares)");
    expect(r.ok).toBe(true);
    expect(r.value).toBe(30);
    await k.disposeAndFlush();
  });

  it("python：状态延续（同 kernelId 变量保留）", async () => {
    const k = new SandboxKernel({ url: baseUrl, secret: SECRET, language: "python" });
    await k.execute("acc = 42");
    const r = await k.execute("_result = acc + 1");
    expect(r.value).toBe(43);
    await k.disposeAndFlush();
  });

  it("bash：执行命令并回传输出", async () => {
    const k = new SandboxKernel({ url: baseUrl, secret: SECRET, language: "bash" });
    const r = await k.execute("echo sandbox-bash-ok");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("sandbox-bash-ok");
    await k.disposeAndFlush();
  });

  it("reset：清命名空间（变量不延续）", async () => {
    const k = new SandboxKernel({ url: baseUrl, secret: SECRET, language: "python" });
    await k.execute("secret_var = 99");
    await k.reset();
    const r = await k.execute("_result = 'secret_var' in dir()");
    expect(r.value).toBe(false);
    await k.disposeAndFlush();
  });

  it("snapshot：聚合状态（变量枚举）", async () => {
    const k = new SandboxKernel({ url: baseUrl, secret: SECRET, language: "python" });
    await k.execute("keep = 75025");
    const snap = await k.snapshot();
    expect(snap.variables.some((v: any) => v.key === "keep" && v.value === 75025)).toBe(true);
    await k.disposeAndFlush();
  });

  it("release 后池内复用（dispose 归还 → 再 acquire 同 id）", async () => {
    const k1 = new SandboxKernel({ url: baseUrl, secret: SECRET, language: "python" });
    await k1.execute("persist = 'kept'");
    const id1 = (k1 as any).kernelId;
    await k1.disposeAndFlush();

    const k2 = new SandboxKernel({ url: baseUrl, secret: SECRET, language: "python" });
    await k2.ready;
    const id2 = (k2 as any).kernelId;
    expect(id2).toBe(id1); // 空闲复用
    const r = await k2.execute("_result = persist");
    expect(r.value).toBe("kept"); // 状态延续
    await k2.disposeAndFlush();
  });

  it("错误传播：宿主不可达 → 明确错误", async () => {
    const k = new SandboxKernel({ url: "http://127.0.0.1:1", secret: SECRET, language: "python" });
    await expect(k.execute("1+1")).rejects.toThrow();
  });
});
