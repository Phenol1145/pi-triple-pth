import { describe, it, expect, vi } from "vitest";
import { spaceRegistry } from "../../src/pth/kernel/execution/space-registry.js";
import { runAgentTask } from "../../src/pth/kernel/execution/agent-loop.js";
import type { LlmFn } from "../../src/pth/kernel/interpreter/llm-fn.js";

describe("space-registry（空间注册表——数据驱动）", () => {
  it("内置空间随模块加载（meta + ts/python/bash/c）", () => {
    expect(spaceRegistry.get("meta")?.kind).toBe("meta");
    for (const id of ["ts", "python", "bash", "c"]) {
      expect(spaceRegistry.isActionSpace(id)).toBe(true);
    }
  });

  it("执行工具反查（门控依据）", () => {
    expect(spaceRegistry.spaceOfExecTool("python_execute")).toBe("python");
    expect(spaceRegistry.spaceOfExecTool("ts")).toBe("ts");
    expect(spaceRegistry.spaceOfExecTool("done")).toBeNull();   // done 不是语言执行工具
  });

  it("内置空间不可注销", () => {
    expect(() => spaceRegistry.unregister("ts")).toThrow(/内置/);
  });
});

// ── agent-loop ASP 状态机 ─────────────────────────────
function mockKernel() {
  return {
    ts: { execute: vi.fn(async (code: string) => ({ ok: true, value: `exec:${code.slice(0, 20)}`, durationMs: 1 })), registerResult: vi.fn() },
    bash: { execute: async () => ({ ok: true, stdout: "ok" }) },
    python: { execute: async () => ({ ok: true, value: 1, stdout: "1" }) },
    llm: { complete: async () => ({ content: "" }) },
    dataWorld: {} as any,
    reset: () => {}, dispose: () => {},
  } as any;
}

function mockLlm(steps: Array<{ toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; content?: string }>): LlmFn {
  let i = 0;
  return {
    // 签名：complete(messages, opts)——tools 在第二参
    complete: vi.fn(async (_messages: unknown, opts?: { tools?: Array<{ name: string }> }) => {
      const step = steps[Math.min(i, steps.length - 1)]!;
      i++;
      return {
        content: step.content ?? "",
        model: "mock",
        usage: { inputTokens: 1, outputTokens: 1 },
        ...(step.toolCalls ? { toolCalls: step.toolCalls.map((tc, idx) => ({ id: `c${i}_${idx}`, name: tc.name, arguments: tc.arguments })) } : {}),
        ...(opts?.tools ? { offeredTools: opts.tools.map((t) => t.name) } : {}),
      };
    }),
  } as LlmFn;
}

const CAPS = { memory: {} } as Record<string, unknown>;

describe("ASP 状态机（asp:true——空间门控）", () => {
  it("元空间初始：语言工具不在工具面（只有 asp_cd + done）", async () => {
    const llm = mockLlm([{ toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] }]);
    await runAgentTask({ llm, kernel: mockKernel(), caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 3 });
    const firstCall = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { tools: Array<{ name: string }> };
    expect(firstCall.tools.map((t) => t.name).sort()).toEqual(["asp_cd", "asp_index", "done", "memory_index"]);
  });

  it("元空间直调 ts → 门控引导（不执行）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "ts", arguments: { code: "return 1" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 5 });
    expect(kernel.ts.execute).not.toHaveBeenCalled();   // 未执行——被门控
    expect(r.ok).toBe(true);
  });

  it("cd ts → ts 可执行；cd meta → done 可提交（完整导航循环）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "asp_cd", arguments: { space: "ts" } }] },
      { toolCalls: [{ name: "ts", arguments: { code: "return 42" } }] },
      { toolCalls: [{ name: "asp_cd", arguments: { space: "meta" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { v: 42 } } }] },
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 8 });
    expect(kernel.ts.execute).toHaveBeenCalledWith("return 42", expect.anything());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ v: 42 });
  });

  it("cd 后工具面切换（ts 空间只提供 asp_cd + ts）", async () => {
    const llm = mockLlm([
      { toolCalls: [{ name: "asp_cd", arguments: { space: "python" } }] },
      { toolCalls: [{ name: "done", arguments: { result: {} } }] },   // done 在 python 空间被门控
      { toolCalls: [{ name: "asp_cd", arguments: { space: "meta" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    await runAgentTask({ llm, kernel: mockKernel(), caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 8 });
    const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallTools = (calls[1]![1] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(secondCallTools.sort()).toEqual(["asp_cd", "asp_index", "memory_index", "python_execute"]);
  });

  it("cd 未知空间 → 报错引导（不迁移）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "asp_cd", arguments: { space: "narnia" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },   // 仍在 meta——done 可用
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 5 });
    expect(r.ok).toBe(true);
  });

  it("ASP 关闭（默认）：旧行为不变（ts/done 直接可用）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "ts", arguments: { code: "return 1" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 });
    expect(kernel.ts.execute).toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });
});

describe("asp.index（空间索引——双聚合模式）", () => {
  function kernelWithSnap() {
    return {
      ts: {
        execute: vi.fn(async () => ({ ok: true, value: 1, durationMs: 1 })),
        registerResult: vi.fn(),
        snapshot: async () => ({ variables: [{ key: "total", value: 42, serializable: true }], functions: [{ key: "helper", source: "function helper(){}" }], oversized: [] }),
      },
      python: { execute: async () => ({ ok: true }), snapshot: async () => ({ variables: [{ key: "py_var", value: 1, serializable: true }], functions: [], oversized: [] }) },
      bash: { execute: async () => ({ ok: true }), snapshot: async () => ({ variables: [], functions: [], oversized: [] }) },
      llm: { complete: async () => ({ content: "" }) },
      dataWorld: {} as any, reset: () => {}, dispose: () => {},
    } as any;
  }
  const capsWith = { memory: { query: async () => [], write: async () => {} }, llm: { complete: async () => ({}) }, fs: { readText: async () => "" }, state: {} } as Record<string, unknown>;

  it("无参默认当前空间（meta → 空间清单）", async () => {
    const llm = mockLlm([
      { toolCalls: [{ name: "asp_index", arguments: {} }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const traces: string[] = [];
    await runAgentTask({ llm, kernel: kernelWithSnap(), caps: capsWith, task: { title: "t", text: "x" }, asp: true, maxSteps: 5,
      onTrace: (e) => { if (e.type === "tool-result") traces.push(e.resultPreview); } });
    expect(traces[0]).toContain("元空间");
  });

  it("ts 空间 by-package：扩展包展开（memory/llm/fs 各包能力键）", async () => {
    const { buildSpaceIndex } = await import("../../src/pth/kernel/execution/space-index.js");
    const out = await buildSpaceIndex({ mode: "by-package" }, { currentSpace: "ts", kernel: kernelWithSnap(), caps: capsWith });
    expect(out).toContain("memory: query/write");
    expect(out).toContain("llm: complete");
    expect(out).toContain("【ts 空间 · 按扩展包】");
  });

  it("ts 空间 by-type：变量/函数快照", async () => {
    const { buildSpaceIndex } = await import("../../src/pth/kernel/execution/space-index.js");
    const out = await buildSpaceIndex({ mode: "by-type", space: "ts" }, { currentSpace: "meta", kernel: kernelWithSnap(), caps: capsWith });
    expect(out).toContain("total");
    expect(out).toContain("helper");
    expect(out).toContain("变量(1)");
  });

  it("python 空间：snapshot 分区视图", async () => {
    const { buildSpaceIndex } = await import("../../src/pth/kernel/execution/space-index.js");
    const out = await buildSpaceIndex({ space: "python" }, { currentSpace: "meta", kernel: kernelWithSnap(), caps: capsWith });
    expect(out).toContain("py_var");
    expect(out).toContain("python 空间");
  });

  it("指定未知空间 → 错误提示含已注册清单", async () => {
    const { buildSpaceIndex } = await import("../../src/pth/kernel/execution/space-index.js");
    const out = await buildSpaceIndex({ space: "narnia" }, { currentSpace: "meta", kernel: kernelWithSnap(), caps: capsWith });
    expect(out).toContain("未知空间");
    expect(out).toContain("ts");
  });

  it("输出体积纪律：单层 ≤ ~2KB", async () => {
    const { buildSpaceIndex } = await import("../../src/pth/kernel/execution/space-index.js");
    const bigCaps: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) bigCaps[`pkg_${i}`] = Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`fn_${j}`, () => {}]));
    const out = await buildSpaceIndex({ mode: "by-package" }, { currentSpace: "ts", kernel: kernelWithSnap(), caps: bigCaps });
    expect(out.length).toBeLessThanOrEqual(2100);   // MAX_LAYER_CHARS + 截断标注余量
    expect(out).toContain("截断");
  });
});
