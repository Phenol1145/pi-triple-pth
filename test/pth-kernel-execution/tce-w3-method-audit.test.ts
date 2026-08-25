import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runPtcProgram } from "@away_from/pth-kernel-interpreter";
import { createKernelManager, createWorkerKernelWithManager } from "../../src/pth/impls/kernels/kernel-manager.js";
import { buildTaskCapabilityInject } from "../../src/pth/runner/exec-modes/task-capability-inject.js";

describe("TCE W3 方法级静态审核", () => {
  let manager: ReturnType<typeof createKernelManager>;
  let kernel: ReturnType<typeof createWorkerKernelWithManager>;

  beforeAll(async () => {
    manager = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    kernel = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: {
        memory: { retrieve: async () => [], write: async () => {} },
        tasks: { candidates: async () => [], submit: async () => {} },
        queryReadOnly: async () => [],
      } as any,
      manager,
      toolstore: null as any,
    });
  });

  afterAll(() => {
    manager.dispose();
  });

  it("acceptor（仅 dev.run/dev.list + write.read/write.list）调 dev.write → 方法级拒绝", async () => {
    kernel.ts.reset();
    const acceptorCaps = ["dev.run", "dev.list", "write.read", "write.list"];
    const capabilityInject = buildTaskCapabilityInject({
      kernel,
      taskWorkspace: "/tmp/tce-w3-acceptor",
      roleCapabilities: acceptorCaps,
    });
    const r = await runPtcProgram({
      code: `await dev.write({path:"x.c",code:"x"});`,
      cwd: "/tmp/tce-w3-acceptor",
      ts: kernel.ts,
      caps: capabilityInject,
      allowedCapabilities: new Set(acceptorCaps),
    });
    expect(r.raw.ok).toBe(false);
    expect(r.raw.error?.code).toBe("capability-out-of-bounds");
    expect(r.raw.error?.message).toContain("dev.write");
  });

  it("acceptor 允许的方法（write.list）不被误杀", async () => {
    kernel.ts.reset();
    const acceptorCaps = ["dev.run", "dev.list", "write.read", "write.list"];
    const capabilityInject = buildTaskCapabilityInject({
      kernel,
      taskWorkspace: "/tmp/tce-w3-acceptor",
      roleCapabilities: acceptorCaps,
    });
    const r = await runPtcProgram({
      code: `return await write.list();`,
      cwd: "/tmp/tce-w3-acceptor",
      ts: kernel.ts,
      caps: capabilityInject,
      allowedCapabilities: new Set(acceptorCaps),
    });
    expect(r.raw.ok).toBe(true);
  });
});
