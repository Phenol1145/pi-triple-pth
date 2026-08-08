import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createKernelManager, createWorkerKernelWithManager } from "../../src/pth/kernel/interpreter/kernel-manager.js";
import { runAgentTask } from "../../src/pth/kernel/execution/agent-loop.js";
import type { LlmFn } from "../../src/pth/kernel/interpreter/llm-fn.js";

/**
 * PTC 程序模式集成测试（P1）：真实 TsInterpreter（vm）+ 真实 PyKernel/BashKernel。
 * mock LLM 单步输出 ts 程序（组合 python 算 + bash 验证）→ 验证真实多 kernel 组合执行。
 */

describe("PTC 程序模式（真实 vm + kernel 集成）", () => {
  let manager: ReturnType<typeof createKernelManager>;
  let kernel: ReturnType<typeof createWorkerKernelWithManager>;

  beforeAll(async () => {
    manager = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    kernel = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} } } as any,
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
          return {
            ok: true,
            content: `{"action":{"tool":"ts","args":{"code":"const py = await python.execute(\\"_result = sum(range(1,101))\\\\n\\"); const b = await bash.execute(\\"echo VAL=\\" + py.value + \\" | grep -c '^VAL=5050$'\\"); return { sum: py.value, verified: Number(b.stdout.trim()) === 1 }; "}}}`,
            durationMs: 1,
            usage: {},
          };
        }
        return { ok: true, content: '{"action":{"tool":"done","args":{"result":{"ptc":true,"sum":5050},"summary":"PTC 完成"}}}', durationMs: 1, usage: {} };
      },
    } as LlmFn;

    const r = await runAgentTask({
      llm, kernel, caps: kernel.capabilities,
      task: { title: "ptc-int", text: "用 ts 程序组合 python 算 1..100 和 + bash 验证" },
      role: { id: "developer", labelPatterns: [], prompt: "你是开发者" },
      maxSteps: 5,
      logger: (m) => console.log("LOG:", m),
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.steps).toBe(2); // 1 步 ts 程序 + 1 步 done（vs 旧 JSON 动作 3+ 步）
      expect(r.value).toEqual({ ptc: true, sum: 5050 });
    }
  });

  it("PTC 程序可跨 kernel 传值（python 结果进 bash 命令）", async () => {
    let step = 0;
    const llm: LlmFn = {
      complete: async () => {
        step++;
        if (step === 1) {
          return {
            ok: true,
            content: `{"action":{"tool":"ts","args":{"code":"const py = await python.execute(\\"x = 6 * 7\\\\n_result = x\\"); const b = await bash.execute(\\"echo \\" + py.value + \\" | wc -c\\"); return { x: py.value, digits: b.stdout.trim() }; "}}}`,
            durationMs: 1,
            usage: {},
          };
        }
        return { ok: true, content: '{"action":{"tool":"done","args":{"result":{"ok":true},"summary":"done"}}}', durationMs: 1, usage: {} };
      },
    } as LlmFn;

    const r = await runAgentTask({
      llm, kernel, caps: kernel.capabilities,
      task: { title: "ptc-int2", text: "跨 kernel 传值" },
      maxSteps: 5,
    });
    expect(r.ok).toBe(true);
  });
});
