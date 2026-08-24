import { describe, it, expect, vi } from "vitest";
import { runPtcAgentTask } from "@away_from/pth-kernel-execution";
import type { AgentTraceEvent } from "@away_from/pth-kernel-execution";
import type { LlmFn, WorkerKernel } from "@away_from/pth-kernel-interpreter";
import { TASK_AWAIT_SUSPENDED_CODE } from "@away_from/pth-contracts";

function mockKernel(executeImpl?: (code: string) => Promise<{ ok: boolean; value?: unknown; error?: { message: string; code?: string }; durationMs: number; stdout?: string }>) {
  return {
    ts: {
      execute: vi.fn(async (code: string) => {
        if (executeImpl) return executeImpl(code);
        return { ok: true, value: 42, durationMs: 1, language: "ts" };
      }),
      reset() {},
      dispose() {},
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      state: { tasks: {} },
    },
    reset: async () => {},
    dispose: async () => {},
    snapshot: async () => ({}),
  } as unknown as WorkerKernel;
}

function mockLlm(responses: string[]) {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const content = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return { content, model: "stub", usage: {} };
    }),
  } as unknown as LlmFn;
}

describe("runPtcAgentTask", () => {
  it("首轮 done=true + finalResult → 成功", async () => {
    const llm = mockLlm(['{"done":true,"finalResult":{"ok":1},"reason":"done"}']);
    const traces: AgentTraceEvent[] = [];
    const r = await runPtcAgentTask({ llm, kernel: mockKernel(), task: { title: "t", text: "x" }, onTrace: (e) => traces.push(e) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ ok: 1 });
    expect(traces.some((e) => e.type === "finish" && e.ok)).toBe(true);
  });

  it("第一次失败第二次修订成功", async () => {
    let calls = 0;
    const kernel = mockKernel(async () => {
      calls++;
      if (calls === 1) return { ok: false, error: { message: "boom" }, durationMs: 1 };
      return { ok: true, value: "fixed", durationMs: 1 };
    });
    const llm = mockLlm([
      '{"done":false,"program":"async function main(){ throw new Error(\\"x\\"); }","reason":"try"}',
      '{"done":true,"finalResult":"fixed","reason":"ok"}',
    ]);
    const r = await runPtcAgentTask({ llm, kernel, task: { title: "t", text: "x" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("fixed");
  });

  it("非法 JSON 走协议失败计数并重试", async () => {
    const llm = mockLlm([
      "not json",
      '{"done":true,"finalResult":1}',
    ]);
    const r = await runPtcAgentTask({ llm, kernel: mockKernel(), task: { title: "t", text: "x" }, maxProtocolFailures: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(1);
  });

  it("协议失败超限 → 失败", async () => {
    const llm = mockLlm(["bad", "bad", "bad"]);
    const r = await runPtcAgentTask({ llm, kernel: mockKernel(), task: { title: "t", text: "x" }, maxProtocolFailures: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ptc-protocol-failed");
  });

  it("达到最大迭代后软终止", async () => {
    const llm = mockLlm(['{"done":false,"program":"async function main(){ return 1; }"}']);
    const r = await runPtcAgentTask({ llm, kernel: mockKernel(), task: { title: "t", text: "x" }, maxIterations: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warning).toContain("ptc-max-iterations");
    }
  });

  it("TASK_AWAIT_SUSPENDED_CODE 传播", async () => {
    const kernel = mockKernel(async () => ({ ok: false, error: { message: "await", code: TASK_AWAIT_SUSPENDED_CODE }, durationMs: 1 }));
    const llm = mockLlm(['{"done":false,"program":"async function main(){ await tasks.await(\\"x\\"); }"}']);
    const r = await runPtcAgentTask({ llm, kernel, task: { title: "t", text: "x" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.code).toBe(TASK_AWAIT_SUSPENDED_CODE);
  });

  it("trace 包含 ptc-program / ptc-result", async () => {
    const llm = mockLlm([
      '{"done":false,"program":"async function main(){ return 1; }"}',
      '{"done":true,"finalResult":1}',
    ]);
    const traces: AgentTraceEvent[] = [];
    await runPtcAgentTask({ llm, kernel: mockKernel(), task: { title: "t", text: "x" }, onTrace: (e) => traces.push(e) });
    expect(traces.some((e) => e.type === "ptc-program")).toBe(true);
    expect(traces.some((e) => e.type === "ptc-result" && e.ok)).toBe(true);
  });
});
