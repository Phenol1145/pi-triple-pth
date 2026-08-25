import { describe, it, expect } from "vitest";
import { AgentTaskRunner } from "../../src/pth/runner/agent-task-runner.js";
import type { TaskLease, TaskWorkItem, TenantScope } from "@away_from/pth-contracts";
import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";
import type { AgentTraceEvent } from "@away_from/pth-kernel-execution";

const scope: TenantScope = { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-1" };
const lease: TaskLease = {
  taskId: "task-1",
  leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6",
  generation: 1,
  scope,
  roleId: "developer",
  workspace: { tenantId: "tenant-a", workspaceId: "task:task-1", taskId: "task-1" },
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
};
const work: TaskWorkItem = {
  taskId: "task-1", scope, title: "do x", text: "return 42;", tags: ["code"], payload: {}, assignedRole: "developer", domains: [],
};

function kernel(): WorkerKernel {
  return {
    reset: async () => {},
    abort: async () => {},
    snapshot: async () => ({}),
    dispose: async () => {},
    ts: { execute: async () => ({ ok: true, value: 42, durationMs: 1, language: "ts" }), state: {}, reset() {}, dispose() {}, snapshot: async () => ({ variables: [], functions: [], oversized: [] }) },
    bash: { execute: async () => ({ ok: true, stdout: "", durationMs: 1, language: "bash" }), state: {}, reset() {}, dispose() {}, snapshot: async () => ({ variables: [], functions: [], oversized: [] }) },
    python: { execute: async () => ({ ok: true, value: 1, durationMs: 1, language: "python" }), state: {}, reset() {}, dispose() {}, snapshot: async () => ({ variables: [], functions: [], oversized: [] }) },
  } as unknown as WorkerKernel;
}

describe("AgentTaskRunner execMode 路由", () => {
  it("显式 tool-call 缺 agentCaps → fail-closed", async () => {
    const runner = new AgentTaskRunner({
      kernel: kernel(),
      role: { id: "developer", tags: [], prompt: "dev" },
      workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" },
      llm: { complete: async () => ({ content: "x", model: "stub", usage: {} }) },
      config: { execMode: "tool-call", execModeExplicit: true, agentMode: true, aspMode: false, pulseMode: false },
    });
    const outcome = await runner.run({ lease, work });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.error?.code).toBe("exec-mode-capability-missing");
  });

  it("PTH_EXEC_MODE=ptc 无 llm → no-llm", async () => {
    const runner = new AgentTaskRunner({
      kernel: kernel(),
      role: { id: "developer", tags: [], prompt: "dev" },
      workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" },
      config: { execMode: "ptc", execModeExplicit: true, agentMode: false, aspMode: false, pulseMode: false },
    });
    const outcome = await runner.run({ lease, work });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.error?.code).toBe("no-llm");
  });

  it("pulse 模式写出 pulse-translate / pulse-result trace 事件", async () => {
    const traces: AgentTraceEvent[] = [];
    const runner = new AgentTaskRunner({
      kernel: kernel(),
      role: { id: "developer", tags: [], prompt: "dev" },
      workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" },
      llm: { complete: async () => ({ content: "return 42;", model: "stub", usage: {} }) },
      config: { execMode: "pulse", execModeExplicit: true, agentMode: false, aspMode: false, pulseMode: true },
      onTrace: (e) => traces.push(e),
    });
    const outcome = await runner.run({ lease, work });
    expect(outcome.status).toBe("completed");
    expect(traces.some((e) => e.type === "pulse-translate" && e.ok)).toBe(true);
    expect(traces.some((e) => e.type === "pulse-result" && e.ok)).toBe(true);
  });
});
