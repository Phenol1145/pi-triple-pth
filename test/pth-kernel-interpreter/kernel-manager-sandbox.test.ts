import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { buildKernelHostApp, createSandboxGrantIssuer, createSandboxGrantVerifier } from "@away_from/pth-sandbox";
import { createKernelManager } from "../../src/pth/impls/kernels/kernel-manager.js";

/**
 * KernelManager sandbox-kernel 模式集成——真实 HTTP 宿主 + 三语言路由。
 */

const SECRET = "test-sandbox-secret";
const GRANT_SECRET = "manager-sandbox-grant-secret-0123456789";
const issuer = createSandboxGrantIssuer({ secret: GRANT_SECRET });
function makeGrant() {
  return issuer.issue({
    lease: { taskId: "task-manager", leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6", generation: 1 },
    scope: { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-manager" },
    workspace: { tenantId: "tenant-a", workspaceId: "ws-manager", taskId: "task-manager" },
    language: "python",
    capabilities: ["memory.read"],
  });
}

describe("KernelManager sandbox-kernel 模式（P5 接线）", () => {
  let host: any;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.SANDBOX_SHARED_SECRET = SECRET;
    host = buildKernelHostApp({
      getSecret: () => SECRET,
      grantVerifier: createSandboxGrantVerifier({ secret: GRANT_SECRET }),
      registerSessions: true,
    });
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
      sandboxKernel: { url: baseUrl, secret: SECRET, grant: makeGrant() },
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
      sandboxKernel: { url: baseUrl, secret: SECRET, grant: makeGrant() },
    });
    await mgr.execute("python", "x = 123");
    // 2026-08-12：await reset（此前不 await 是竞态——依赖微任务时序侥幸通过；
    // SandboxKernel 自愈改动的 catch 链多一跳微任务后时序翻转——测试暴露）
    await mgr.reset();
    const r = await mgr.execute("python", "_result = 'x' in dir()");
    expect(r.value).toBe(false);
    mgr.dispose();
  });
});
