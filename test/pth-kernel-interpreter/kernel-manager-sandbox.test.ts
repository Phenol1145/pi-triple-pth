import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { buildKernelHostApp } from "../../src/sandbox/kernel-host.js";
import { createKernelManager } from "../../src/pth/kernel/interpreter/kernel-manager.js";

/**
 * KernelManager sandbox-kernel 模式集成——真实 HTTP 宿主 + 三语言路由。
 */

const SECRET = "test-sandbox-secret";

describe("KernelManager sandbox-kernel 模式（P5 接线）", () => {
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

  it("pythonMode=bashMode=sandbox-kernel：三语言路由到宿主", async () => {
    const mgr = createKernelManager({
      pythonMode: "sandbox-kernel",
      bashMode: "sandbox-kernel",
      sandboxKernel: { url: baseUrl, secret: SECRET },
    });
    const py = await mgr.execute("python", "arr = [1,2,3]\n_result = sum(arr)");
    expect(py.ok).toBe(true);
    expect(py.value).toBe(6);
    // python 状态延续（同一 SandboxKernel）
    const py2 = await mgr.execute("python", "_result = len(arr)");
    expect(py2.value).toBe(3);
    const bash = await mgr.execute("bash", "echo mgr-sandbox-ok");
    expect(bash.ok).toBe(true);
    expect(bash.stdout).toContain("mgr-sandbox-ok");
    // ts 仍是本地 vm（指挥层留 PTH 侧）
    const ts = await mgr.execute("ts", "return 7 * 7");
    expect(ts.value).toBe(49);
    mgr.dispose();
  });

  it("reset 经 manager 清宿主命名空间", async () => {
    const mgr = createKernelManager({
      pythonMode: "sandbox-kernel",
      sandboxKernel: { url: baseUrl, secret: SECRET },
    });
    await mgr.execute("python", "x = 123");
    mgr.reset();
    const r = await mgr.execute("python", "_result = 'x' in dir()");
    expect(r.value).toBe(false);
    mgr.dispose();
  });
});
