import { describe, it } from "vitest";
import { createKernelModelRouter } from "../src/pth/kernel/execution/model-router.js";
import { createLlmFn } from "../src/pth/kernel/interpreter/llm-fn.js";
import { runAgentTask } from "../src/pth/kernel/execution/agent-loop.js";
import { createKernelManager, createWorkerKernelWithManager } from "../src/pth/impls/kernels/kernel-manager.js";

describe("agent debug full2", () => {
  it("完整 agent 循环（单轮消息模式）", async () => {
    const router = await createKernelModelRouter();
    const llm = createLlmFn({ modelRouter: router });
    const manager = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    const kernel = createWorkerKernelWithManager({ llm, dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as any, manager, toolstore: null as any });
    const r = await runAgentTask({
      llm, kernel, caps: kernel.capabilities,
      task: { title: "agent-fib", text: "用 python 计算斐波那契数列第 25 项，然后用 bash 验证结果不为空，返回最终数值" },
      role: { id: "developer", labelPatterns: [], prompt: "你是开发者——负责代码实现" },
      maxSteps: 5,
      logger: (m) => console.log("LOG:", m),
    });
    console.log("RESULT:", JSON.stringify(r).slice(0, 400));
    manager.dispose();
  }, 120000);
});
