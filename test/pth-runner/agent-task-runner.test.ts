import { describe, expect, it, vi } from "vitest";
import { AgentTaskRunner } from "../../src/pth/runner/agent-task-runner.js";
import type { TaskLease, TaskWorkItem, TenantScope } from "../../src/pth/contracts/index.js";
import type { WorkerKernel } from "../../src/pth/kernel/interpreter/index.js";
import type { LlmFn } from "../../src/pth/kernel/interpreter/llm-fn.js";
import { runAgentTask } from "../../src/pth/kernel/execution/agent-loop.js";

vi.mock("../../src/pth/kernel/execution/agent-loop.js", () => ({
  runAgentTask: vi.fn(),
}));

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
  taskId: "task-1", scope, title: "do x", text: "return 42;", tags: ["code"], payload: {}, assignedRole: "developer",
};

function fakeKernel(opts: { resetMs?: number; executeOk?: boolean } = {}) {
  const calls: string[] = [];
  let resetDone = false;
  let executed = false;
  const kernel = {
    ts: {
      language: "ts",
      execute: async () => {
        calls.push("execute");
        executed = true;
        if (!resetDone) throw new Error("executed before reset completed");
        return opts.executeOk === false
          ? { ok: false, stdout: "", stderr: "", durationMs: 1, language: "ts", error: { message: "boom" } }
          : { ok: true, stdout: "", stderr: "", durationMs: 1, language: "ts", value: 42 };
      },
      state: {},
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      reset() {},
      dispose() {},
    },
    bash: {
      language: "bash",
      execute: async () => ({ ok: true, stdout: "", stderr: "", durationMs: 0, language: "bash" }),
      state: {},
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      reset() {},
      dispose() {},
    },
    python: {
      language: "python",
      execute: async () => ({ ok: true, stdout: "", stderr: "", durationMs: 0, language: "python" }),
      state: {},
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      reset() {},
      dispose() {},
    },
    llm: null,
    dataWorld: null,
    reset: async () => {
      await new Promise((r) => setTimeout(r, opts.resetMs ?? 5));
      resetDone = true;
      calls.push("reset");
    },
    snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
    dispose() {},
  } as unknown as WorkerKernel;
  return {
    kernel,
    calls,
    get resetDone() { return resetDone; },
    get executed() { return executed; },
  };
}

const fakeLlm: LlmFn = {
  complete: async () => ({ content: "return { ok: true };" }),
};

describe("AgentTaskRunner（P1-4）", () => {
  it("await kernel.reset() 完成后才执行（异步 reset 也等待）", async () => {
    const { kernel, calls } = fakeKernel();
    const runner = new AgentTaskRunner({
      kernel,
      role: { id: "developer", tags: ["code"], prompt: "dev" },
      workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" },
      llm: fakeLlm,
      config: { agentMode: false, aspMode: false },
    });
    const outcome = await runner.run({ lease, work });
    expect(outcome.status).toBe("completed");
    expect(calls.indexOf("reset")).toBeLessThan(calls.indexOf("execute"));
  });

  it("PTC 执行失败 → rejected（execution-failed）", async () => {
    const { kernel } = fakeKernel({ executeOk: false });
    const runner = new AgentTaskRunner({
      kernel,
      role: { id: "developer", tags: ["code"], prompt: "dev" },
      workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" },
      llm: fakeLlm,
      config: { agentMode: false, aspMode: false },
    });
    const outcome = await runner.run({ lease, work });
    expect(outcome.status).toBe("rejected");
    expect(outcome.error?.code).toBe("execution-failed");
  });

  it("取消信号（执行前 aborted）→ cancelled 且不执行", async () => {
    const { kernel, executed } = fakeKernel();
    const runner = new AgentTaskRunner({
      kernel,
      role: { id: "developer", tags: ["code"], prompt: "dev" },
      workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" },
      llm: fakeLlm,
      config: { agentMode: false, aspMode: false },
    });
    const controller = new AbortController();
    controller.abort();
    const outcome = await runner.run({ lease, work, signal: controller.signal });
    expect(outcome.status).toBe("cancelled");
    expect(outcome.retryable).toBe(true);
    expect(executed).toBe(false);
  });

  it("无 llm → rejected（no-llm）", async () => {
    const { kernel } = fakeKernel();
    const runner = new AgentTaskRunner({
      kernel,
      role: { id: "developer", tags: ["code"], prompt: "dev" },
      workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" },
    });
    const outcome = await runner.run({ lease, work });
    expect(outcome.status).toBe("rejected");
    expect(outcome.error?.code).toBe("no-llm");
  });

  it("agent 失败 → rejected（agent-failed）；agent 成功 → completed", async () => {
    const { kernel } = fakeKernel();
    const role = { id: "developer", tags: ["code"], prompt: "dev" };
    const caps = { memory: {} };
    vi.mocked(runAgentTask).mockResolvedValueOnce({ ok: false, error: "agent exploded", steps: 1 });
    const failRunner = new AgentTaskRunner({ kernel, role, workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" }, llm: fakeLlm, caps, config: { agentMode: true, aspMode: false } });
    const failOutcome = await failRunner.run({ lease, work });
    expect(failOutcome.status).toBe("rejected");
    expect(failOutcome.error?.code).toBe("agent-failed");

    vi.mocked(runAgentTask).mockResolvedValueOnce({ ok: true, value: { done: true }, summary: "done", steps: 2 });
    const okOutcome = await failRunner.run({ lease, work });
    expect(okOutcome.status).toBe("completed");
    expect(okOutcome.result).toMatchObject({ value: { done: true }, steps: 2 });
  });
});
