import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runAgentTask, type AgentTraceEvent } from "@away_from/pth-kernel-execution";
import type { LlmFn } from "@away_from/pth-kernel-interpreter";
import { createKernelManager, createWorkerKernelWithManager } from "../../src/pth/impls/kernels/kernel-manager.js";
import { buildTaskCapabilityInject } from "../../src/pth/runner/exec-modes/task-capability-inject.js";

describe("TCE W2 tool-call 投影化", () => {
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

  it("write.create 走 asAction 投影并在 trace 带 capabilityId，产物真实落盘", async () => {
    const ws = "/tmp/tce-w2-proj";
    const { mkdir, readFile, rm } = await import("node:fs/promises");
    await rm(ws, { recursive: true, force: true });
    await mkdir(ws, { recursive: true });

    const capabilityInject = buildTaskCapabilityInject({
      kernel,
      taskWorkspace: ws,
      roleCapabilities: [
        "write.create", "write.edit", "write.read", "write.list", "write.save", "write.section",
      ],
    });

    const traces: AgentTraceEvent[] = [];
    let step = 0;
    const llm: LlmFn = {
      complete: async () => {
        step++;
        if (step === 1) {
          return { content: "", model: "mock", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "c1", name: "write.create", arguments: { path: "guide.md", content: "# 指南\n" } }] };
        }
        return { content: "", model: "mock", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "c2", name: "done", arguments: { result: { ok: true }, summary: "done" } }] };
      },
    };

    const r = await runAgentTask({
      llm,
      kernel,
      caps: kernel.capabilities,
      task: { title: "write", text: "写文档" },
      taskWorkspace: ws,
      capabilityInject,
      maxSteps: 4,
      onTrace: (e) => { traces.push(e); },
    });

    expect(r.ok).toBe(true);
    const resultEvent = traces.find((e) => e.type === "tool-result" && e.tool === "write.create");
    expect(resultEvent?.ok).toBe(true);
    expect(resultEvent?.capabilityId).toBe("write.create");
    const content = await readFile(`${ws}/guide.md`, "utf-8");
    expect(content).toContain("# 指南");
    await rm(ws, { recursive: true, force: true });
  });
});
