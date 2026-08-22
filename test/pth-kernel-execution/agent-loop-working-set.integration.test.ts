import { describe, expect, it, vi } from "vitest";
import { runAgentTask } from "@away_from/pth-kernel-execution";
import type { LlmFn } from "@away_from/pth-kernel-interpreter";
import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";
import type { ToolRegSnapshot } from "@away_from/pth-kernel-interpreter";
import type { ToolRegSpec } from "@away_from/pth-memory";

function fakeKernel(): WorkerKernel {
  const execute = vi.fn(async () => ({ ok: true, value: { ran: true }, durationMs: 1, language: "ts" }));
  return {
    ts: { execute, reset: vi.fn(), dispose: vi.fn(), snapshot: vi.fn(async () => ({ variables: [], functions: [], oversized: [] })), registerResult: vi.fn(), injectCapability: vi.fn(), state: {} } as never,
    python: {} as never,
    bash: {} as never,
    llm: null as never,
    dataWorld: null as never,
    reset: vi.fn(),
    dispose: vi.fn(),
    snapshot: vi.fn(async () => ({ variables: [], functions: [], oversized: [] })),
  };
}

const OMITTED_SPEC: ToolRegSpec = {
  name: "registry.omitted",
  version: 1,
  description: { anchor: "probe", whenToUse: "probe", effect: "probe" },
  parameters: { type: "object", properties: { probe: { type: "boolean" } }, required: [] },
  executor: { type: "program", source: "return { executed: true };" },
  visibility: { roles: ["researcher"], pack: "n28" },
};

describe("agent-loop working-set（不 mock runAgentTask）", () => {
  it("same-space Role-visible 但预算外工具：三处同源拒绝且 executor 零调用", async () => {
    const seen: Array<{ tools: string[] }> = [];
    const llm: LlmFn = {
      complete: async (_messages, options) => {
        seen.push({ tools: (options?.tools ?? []).map((tool) => tool.name) });
        if (seen.length === 1) return { content: "", model: "stub", usage: {}, toolCalls: [{ id: "c1", name: "registry_omitted", arguments: { probe: true } }] };
        return { content: "", model: "stub", usage: {}, toolCalls: [{ id: "c2", name: "done", arguments: { result: { ok: true } } }] };
      },
    };
    const kernel = fakeKernel();
    const registry: ToolRegSnapshot = { version: "v1", takenAt: 1, entries: new Map([["registry.omitted", OMITTED_SPEC]]) };
    const trace: Array<{ type: string; tool?: string; ok?: boolean; resultPreview?: string }> = [];
    const result = await runAgentTask({
      llm,
      kernel,
      caps: {},
      task: { title: "t", text: "x" },
      role: { id: "researcher", tags: ["research"], prompt: "p" },
      asp: true,
      maxSteps: 5,
      toolRegistry: registry,
      toolAllowlist: ["done"],
      onTrace: (e) => trace.push(e as never),
    });
    expect(result.ok).toBe(true);
    expect(seen[0]!.tools).toEqual(["done"]);   // frozen union ∩ meta face；隐藏工具不广告
    expect(JSON.stringify(seen)).not.toContain("registry.omitted");
    expect(trace).toContainEqual(expect.objectContaining({ type: "tool-result", tool: "registry.omitted", ok: false, resultPreview: "tool registry.omitted is outside the frozen Task Working Set" }));
    const messages = (runAgentTask as never as { __messages?: Array<{ role: string; content: string }> })["__messages"];
    void messages;
    expect(kernel.ts.execute).not.toHaveBeenCalled();   // omitted program executor 零调用
  });

  it("双名归一：registry_omitted 与 registry.omitted 都归一到一个 policy 名且 executor 零调用", async () => {
    const attempts = ["registry_omitted", "registry.omitted"];
    let index = 0;
    const llm: LlmFn = {
      complete: async () => {
        if (index < attempts.length) {
          const name = attempts[index++]!;
          return { content: "", model: "stub", usage: {}, toolCalls: [{ id: `c-${name}`, name, arguments: {} }] };
        }
        return { content: "", model: "stub", usage: {}, toolCalls: [{ id: "c-done", name: "done", arguments: { result: { ok: true } } }] };
      },
    };
    const kernel = fakeKernel();
    const trace: Array<{ type: string; tool?: string; resultPreview?: string }> = [];
    const result = await runAgentTask({
      llm, kernel, caps: {}, task: { title: "t", text: "x" },
      role: { id: "researcher", tags: ["research"], prompt: "p" },
      asp: true, maxSteps: 5,
      toolRegistry: { version: "v1", takenAt: 1, entries: new Map([["registry.omitted", OMITTED_SPEC]]) },
      toolAllowlist: ["done"],
      onTrace: (e) => trace.push(e as never),
    });
    expect(result.ok).toBe(true);
    const denials = trace.filter((e) => e.type === "tool-result" && e.tool === "registry.omitted");
    expect(denials).toHaveLength(2);
    expect(kernel.ts.execute).not.toHaveBeenCalled();
  });
});
