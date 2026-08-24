import { describe, it, expect, vi } from "vitest";
import { runAgentTask } from "@away_from/pth-kernel-execution";
import { CommandAdapterRegistry, programAdapter, normalizeExecutionRequestToCommand } from "@away_from/pth-kernel-execution";
import type { CommandGateway, CommandSecurityContext, ExecutionCommand, ExecutionRequest, UnifiedExecutionDispatcher } from "@away_from/pth-kernel-execution";
import type { ToolRegSpec } from "@away_from/pth-memory";
import type { LlmFn, WorkerKernel } from "@away_from/pth-kernel-interpreter";

function mockKernel(): WorkerKernel {
  return {
    ts: {
      execute: vi.fn(async () => ({ ok: true, value: 42, durationMs: 1, language: "ts" })),
      reset() {},
      dispose() {},
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      state: {},
    },
    reset: async () => {},
    dispose: async () => {},
    snapshot: async () => ({}),
  } as unknown as WorkerKernel;
}

function registrySpec(): ToolRegSpec {
  return {
    name: "util.prog",
    version: 1,
    description: { anchor: "a", whenToUse: "w", effect: "e" },
    parameters: { type: "object", properties: {}, required: [] },
    executor: { type: "program", source: "return 1;" },
    command: "program:util",
    visibility: { roles: ["developer"], pack: "util" },
  };
}

function mockLlm(roleId: string) {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const llm = {
    complete: vi.fn(async () => {
      if (calls.length === 0) {
        calls.push({ name: "util_prog", arguments: {} });
        return { content: "", model: "stub", usage: {}, toolCalls: [{ id: "tc-1", name: "util_prog", arguments: {} }] };
      }
      calls.push({ name: "done", arguments: { result: { ok: true } } });
      return { content: "", model: "stub", usage: {}, toolCalls: [{ id: "tc-2", name: "done", arguments: { result: { ok: true } } }] };
    }),
  } as unknown as LlmFn;
  return { llm, calls };
}

describe("agent-loop adapter + dispatcher 执行缝", () => {
  it("program adapter 经 CommandGateway/Execute 执行并回填 trace", async () => {
    const spec = registrySpec();
    const toolRegistry = {
      version: "tr-1-test",
      takenAt: Date.now(),
      entries: new Map([[spec.name, spec]]),
    };
    const adapterRegistry = new CommandAdapterRegistry();
    adapterRegistry.register("program:util", programAdapter(spec.executor.source));

    const security: CommandSecurityContext = { principalId: "worker:developer", tenantId: "tenant-a", roleId: "developer", taskId: "task-1" };
    const gateway: CommandGateway = {
      decide: async () => ({ kind: "deny", reason: "not used" }),
      decideRequest: async (request: ExecutionRequest, ctx: CommandSecurityContext) => {
        const command = normalizeExecutionRequestToCommand(request, ctx, "cmd-1");
        return { kind: "execute", command };
      },
    };
    const dispatcher: UnifiedExecutionDispatcher = {
      execute: vi.fn(async (command: ExecutionCommand) => {
        expect(command.kind).toBe("language");
        return { ok: true, value: 42, stdout: "42", durationMs: 3, target: command.target ?? undefined };
      }),
    };

    const traces: Array<{ type: string; adapterId?: string; ok?: boolean }> = [];
    const { llm } = mockLlm("developer");
    const r = await runAgentTask({
      llm,
      kernel: mockKernel(),
      caps: {},
      task: { title: "t", text: "x" },
      role: { id: "developer", labelPatterns: [], prompt: "dev", actionTools: ["execTs", "nav", "cache"] } as never,
      toolRegistry,
      adapterRegistry,
      executionDispatcher: dispatcher,
      commandGateway: gateway,
      commandContext: security,
      onTrace: (e) => traces.push(e as never),
    });

    expect(r.ok).toBe(true);
    expect(dispatcher.execute).toHaveBeenCalledTimes(1);
    expect(traces.some((e) => e.type === "tool-result" && e.adapterId === "program:util")).toBe(true);
  });
});
