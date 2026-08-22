import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createKernelManager, createWorkerKernelWithManager } from "../../src/pth/impls/kernels/kernel-manager.js";
import { runAgentTask } from "@away_from/pth-kernel-execution";
import type { LlmFn } from "@away_from/pth-kernel-interpreter";

/**
 * PTC 程序模式集成测试（P1）：真实 TsInterpreter（vm）+ 真实 PyKernel/BashKernel。
 * mock LLM 原生 tool_calls 调 ts 工具（组合 python 算 + bash 验证）→ 真实多 kernel 组合执行。
 */

const PTC_CODE_1 = `const py = await python.execute("_result = sum(range(1,101))\\n"); const b = await bash.execute("echo VAL=" + py.value + " | grep -c '^VAL=5050$'"); return { sum: py.value, verified: Number(b.stdout.trim()) === 1 }; `;
const PTC_CODE_2 = `const py = await python.execute("x = 6 * 7\\n_result = x"); const b = await bash.execute("echo " + py.value + " | wc -c"); return { x: py.value, digits: b.stdout.trim() }; `;

describe("PTC 程序模式（真实 vm + kernel 集成）", () => {
  let manager: ReturnType<typeof createKernelManager>;
  let kernel: ReturnType<typeof createWorkerKernelWithManager>;

  beforeAll(async () => {
    manager = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    kernel = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as any,
      manager,
      toolstore: null as any,
    });
  });

  afterAll(() => {
    manager.dispose();
  });

  it("单 ts 程序组合 python.execute + bash.execute（真实执行 + 值传递）", async () => {
    let step = 0;
    const llm: LlmFn = {
      complete: async () => {
        step++;
        if (step === 1) {
          return { content: "", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "c1", name: "ts.run", arguments: { code: PTC_CODE_1 } }] };
        }
        return { content: "", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "c2", name: "done", arguments: { result: { ptc: true, sum: 5050 }, summary: "PTC 完成" } }] };
      },
    } as LlmFn;

    const r = await runAgentTask({
      llm, kernel, caps: kernel.capabilities,
      task: { title: "ptc-int", text: "用 ts 程序组合 python 算 1..100 和 + bash 验证" },
      role: { id: "developer", tags: [], labelPatterns: [], prompt: "你是开发者" },
      maxSteps: 5,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.steps).toBe(2); // 1 步 ts 程序 + 1 步 done
      expect(r.value).toEqual({ ptc: true, sum: 5050 });
    }
  });

  it("ts 程序内引用 python 结果 + bash 输出（真实值传递）", async () => {
    let step = 0;
    const llm: LlmFn = {
      complete: async () => {
        step++;
        if (step === 1) {
          return { content: "", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "c1", name: "ts.run", arguments: { code: PTC_CODE_2 } }] };
        }
        return { content: "", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "c2", name: "done", arguments: { result: { ok: true }, summary: "done" } }] };
      },
    } as LlmFn;

    const r = await runAgentTask({
      llm, kernel, caps: kernel.capabilities,
      task: { title: "ptc-int2", text: "x=6*7 并用 bash 测位数" },
      maxSteps: 5,
    });
    expect(r.ok).toBe(true);
  });
});
