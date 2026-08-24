import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runPtcProgram } from "@away_from/pth-kernel-interpreter";
import { createKernelManager, createWorkerKernelWithManager } from "../../src/pth/impls/kernels/kernel-manager.js";
import { buildTaskCapabilityInject } from "../../src/pth/runner/exec-modes/task-capability-inject.js";

describe("TCE W1 能力对象注入", () => {
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

  it("coder 能力集注入 dev/write 对象——ts 程序内可调用并读写任务工作区", async () => {
    const ws = "/tmp/tce-w1-coder";
    const { mkdir, rm } = await import("node:fs/promises");
    await rm(ws, { recursive: true, force: true });
    await mkdir(ws, { recursive: true });

    const capabilityInject = buildTaskCapabilityInject({
      kernel,
      taskWorkspace: ws,
      roleCapabilities: [
        "dev.write", "dev.edit", "dev.build", "dev.run", "dev.save", "dev.list",
        "write.create", "write.edit", "write.read", "write.list", "write.save", "write.section",
      ],
    });
    const r = await runPtcProgram({
      code: `await dev.write({path:"main.c",code:"int main(){return 0;}"}); const v = await write.read({path:"main.c"}); return v;`,
      cwd: ws,
      ts: kernel.ts,
      caps: capabilityInject,
    });
    expect(r.raw.ok).toBe(true);
    expect((r.raw.value as any).value.path).toBe("main.c");
    expect((r.raw.value as any).value.length).toBeGreaterThan(0);
    await rm(ws, { recursive: true, force: true });
  });

  it("无能力角色不注入 dev/write 根——surface 预检拒绝", async () => {
    kernel.ts.reset();
    const capabilityInject = buildTaskCapabilityInject({
      kernel,
      taskWorkspace: "/tmp/tce-w1-none",
      roleCapabilities: ["fs", "memory"],
    });
    const r = await runPtcProgram({
      code: `await dev.write({path:"x.c",code:"x"});`,
      cwd: "/tmp/tce-w1-none",
      ts: kernel.ts,
      caps: capabilityInject,
    });
    expect(r.raw.ok).toBe(false);
    expect(r.raw.error?.code).toBe("capability-out-of-bounds");
  });
});
