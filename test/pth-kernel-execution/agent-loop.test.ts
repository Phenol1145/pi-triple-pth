import { describe, it, expect, vi } from "vitest";
import { runAgentTask } from "../../src/pth/kernel/execution/agent-loop.js";
import type { LlmFn } from "../../src/pth/kernel/interpreter/llm-fn.js";
import type { WorkerKernel } from "../../src/pth/kernel/interpreter/index.js";

function mockKernel(): WorkerKernel {
  return {
    ts: {
      execute: vi.fn(async (code: string) => ({ ok: true, value: { fromTs: true }, durationMs: 1, language: "ts" })),
      reset: vi.fn(),
      dispose: vi.fn(),
      snapshot: vi.fn(async () => ({ variables: [], functions: [], oversized: [] })),
    } as any,
    python: {
      execute: vi.fn(async (code: string) => ({ ok: true, value: code.includes("fib") ? 75025 : 42, durationMs: 1, language: "python" })),
      reset: vi.fn(),
      dispose: vi.fn(),
      snapshot: vi.fn(async () => ({ variables: [], functions: [], oversized: [] })),
    } as any,
    bash: {
      execute: vi.fn(async (cmd: string) => ({ ok: true, stdout: `bash:${cmd.length}`, durationMs: 1, language: "bash" })),
      reset: vi.fn(),
      dispose: vi.fn(),
      snapshot: vi.fn(async () => ({ variables: [], functions: [], oversized: [] })),
    } as any,
    llm: null as any,
    dataWorld: null as any,
    reset: vi.fn(),
    dispose: vi.fn(),
    snapshot: vi.fn(async () => ({ variables: [], functions: [], oversized: [] })),
  };
}

function mockLlm(steps: string[]): LlmFn {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const content = steps[Math.min(i, steps.length - 1)]!;
      i++;
      return { ok: true, content, durationMs: 5, usage: {} };
    }),
  };
}

const CAPS = { web: {}, state: {}, fs: {}, memory: {} } as Record<string, unknown>;

describe("runAgentTask（agent 循环）", () => {
  it("多步执行：python 算 → done 提交（工具被正确调用）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      '{"thought":"用 python 算","action":{"tool":"python.execute","args":{"code":"fib"}}}',
      '{"action":{"tool":"done","args":{"result":{"fib25":75025},"summary":"完成"}}}',
    ]);
    const r = await runAgentTask({
      llm, kernel, caps: CAPS,
      task: { title: "t", text: "算 fib(25)" },
      role: { id: "developer", labelPatterns: [], prompt: "你是开发者" },
      maxSteps: 5,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.steps).toBe(2);
      expect(r.value).toEqual({ fib25: 75025 });
      expect(kernel.python.execute).toHaveBeenCalledWith("fib");
    }
  });

  it("LLM 输出带围栏和多余文字也能解析", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      '好的，我来处理。\n```json\n{"action":{"tool":"bash.execute","args":{"command":"ls"}}}\n```\n执行结果如上。',
      '{"action":{"tool":"done","args":{"result":{"ok":true}}}}',
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(kernel.bash.execute).toHaveBeenCalledWith("ls");
  });

  it("超 maxSteps 强制终止（partial result + warning）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm(['{"action":{"tool":"bash.execute","args":{"command":"x"}}}']);  // 永远不 done
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toContain("maxSteps");
  });

  it("动作解析失败重试 1 次后仍失败 → ok:false", async () => {
    const kernel = mockKernel();
    const llm = mockLlm(["这不是 JSON", "也不是 JSON"]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("action-parse-failed");
  });

  it("done 缺 result 视为失败", async () => {
    const kernel = mockKernel();
    const llm = mockLlm(['{"action":{"tool":"done","args":{}}}']);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 });
    expect(r.ok).toBe(false);
  });
});
