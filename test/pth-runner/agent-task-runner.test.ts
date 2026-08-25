import { describe, expect, it, vi } from "vitest";
import { AgentTaskRunner } from "../../src/pth/runner/agent-task-runner.js";
import type { ExecutionGrant, TaskLease, TaskWorkItem, TenantScope, WorkerReplicaRef } from "@away_from/pth-contracts";
import type { ProfessionalArtifactPort } from "../../src/pth/runner/professional-task-capability.js";
import type { ProfessionalRuntimeRegistry } from "../../src/pth/execution/professional-runtime.js";
import type { ExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";
import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";
import type { LlmFn } from "@away_from/pth-kernel-interpreter";
import { runAgentTask } from "@away_from/pth-kernel-execution";

vi.mock("@away_from/pth-kernel-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@away_from/pth-kernel-execution")>();
  return { ...actual, runAgentTask: vi.fn() };
});

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
  complete: async () => ({ content: "return { ok: true };", model: "stub", usage: {} }),
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

  it("W8 P2：task-await-suspended 错误码 → retryable rejected（释放认领回 pending）", async () => {
    const { kernel } = fakeKernel();
    (kernel.ts as unknown as { execute: () => Promise<unknown> }).execute = async () => ({
      ok: false, stdout: "", stderr: "", durationMs: 1, language: "ts",
      error: { message: "等待子任务 child-1 终态（当前 pending）", code: "task-await-suspended" },
    });
    const runner = new AgentTaskRunner({
      kernel,
      role: { id: "developer", tags: ["code"], prompt: "dev" },
      workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" },
      llm: fakeLlm,
      config: { agentMode: false, aspMode: false },
    });
    const outcome = await runner.run({ lease, work });
    expect(outcome.status).toBe("rejected");
    expect(outcome.retryable).toBe(true);
    expect(outcome.error).toEqual({ code: "task-await-suspended", message: "等待子任务 child-1 终态（当前 pending）" });
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

  it("K3：provider 成功时正文追加 Knowledge Context + capabilityInject.knowledge，space 缺省 meta 显式传", async () => {
    vi.mocked(runAgentTask).mockReset();
    vi.mocked(runAgentTask).mockResolvedValue({ ok: true, value: { done: true }, summary: "done", steps: 1 });

    const build = vi.fn(async (input: { tenantId: string; space: string; roleId: string; domains: readonly string[]; title: string; text: string; catalogVersion: string }) => ({
      id: "kc-abc12345",
      catalogVersion: "cat-1",
      queryFingerprint: "abc12345",
      domains: ["math"],
      entries: [{ entryId: "e1", version: 1, anchor: "math", summary: "summary-1", evidence: [], exposedMeta: { kind: "domain-fact", domains: ["math"] } }],
      omitted: { count: 0, reason: "budget" },
    }));

    const { kernel } = fakeKernel();
    const runner = new AgentTaskRunner({
      kernel,
      role: { id: "developer", tags: ["code"], prompt: "dev" },
      workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" },
      llm: fakeLlm,
      caps: { memory: {} },
      config: { agentMode: true, aspMode: false },
      knowledgeContextProvider: { build },
    });

    const outcome = await runner.run({ lease, work });

    expect(outcome.status).toBe("completed");
    expect(build).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      space: "meta",
      roleId: "developer",
      domains: [],
      title: "do x",
      text: "return 42;",
      catalogVersion: "",
    });

    const opts = vi.mocked(runAgentTask).mock.calls[0]![0] as { task: { title: string; text: string }; capabilityInject: Record<string, unknown> };
    expect(opts.task.title).toBe("do x");
    expect(opts.task.text).toContain("【Knowledge Context（catalog cat-1）】");
    expect(opts.task.text).toContain("- [e1] math: summary-1");
    expect(opts.capabilityInject["knowledge"]).toEqual({
      context: {
        id: "kc-abc12345",
        catalogVersion: "cat-1",
        queryFingerprint: "abc12345",
        domains: ["math"],
        entries: [{ entryId: "e1", version: 1, anchor: "math", summary: "summary-1", evidence: [], exposedMeta: { kind: "domain-fact", domains: ["math"] } }],
        omitted: { count: 0, reason: "budget" },
      },
    });
  });

  it("AB-03：adversarial/memory-keeper 的 knowledge.review/promote 与 context 合并，不覆盖", async () => {
    vi.mocked(runAgentTask).mockReset();
    vi.mocked(runAgentTask).mockResolvedValue({ ok: true, value: { done: true }, summary: "done", steps: 1 });

    const knowledgeContext = {
      id: "kc-abc12345",
      catalogVersion: "cat-1",
      queryFingerprint: "abc12345",
      domains: ["math"],
      entries: [{ entryId: "e1", version: 1, anchor: "math", summary: "summary-1", evidence: [], exposedMeta: { kind: "domain-fact", domains: ["math"] } }],
      omitted: { count: 0, reason: "budget" },
    };
    const build = vi.fn(async () => knowledgeContext);

    const cases: Array<{ roleId: string; knowledge: Record<string, unknown> }> = [
      { roleId: "controller:adversarial", knowledge: { review: { canReview: true }, promote: { canPromote: false } } },
      { roleId: "memory-keeper", knowledge: { review: { canReview: false }, promote: { canPromote: true } } },
    ];

    for (const c of cases) {
      const { kernel } = fakeKernel();
      const runner = new AgentTaskRunner({
        kernel,
        role: { id: c.roleId, tags: [], prompt: c.roleId },
        workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" },
        llm: fakeLlm,
        caps: { knowledge: c.knowledge, memory: {} },
        config: { agentMode: true, aspMode: false },
        knowledgeContextProvider: { build },
      });

      const outcome = await runner.run({ lease, work });
      expect(outcome.status).toBe("completed");

      const opts = vi.mocked(runAgentTask).mock.calls.at(-1)![0] as {
        capabilityInject: Record<string, unknown>;
      };
      const injected = opts.capabilityInject["knowledge"] as Record<string, unknown>;
      expect(injected).toMatchObject(c.knowledge);
      expect(injected["context"]).toEqual(knowledgeContext);
    }
  });

  it("K3：provider 抛错 → logger warn + 原文执行（不追加上下文，不注入 knowledge）", async () => {
    vi.mocked(runAgentTask).mockReset();
    vi.mocked(runAgentTask).mockResolvedValue({ ok: true, value: { done: true }, summary: "done", steps: 1 });

    const logs: string[] = [];
    const { kernel } = fakeKernel();
    const runner = new AgentTaskRunner({
      kernel,
      role: { id: "developer", tags: ["code"], prompt: "dev" },
      workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" },
      llm: fakeLlm,
      caps: { memory: {} },
      config: { agentMode: true, aspMode: false },
      logger: (m) => logs.push(m),
      knowledgeContextProvider: {
        build: async () => {
          throw new Error("kb down");
        },
      },
    });

    const outcome = await runner.run({ lease, work });

    expect(outcome.status).toBe("completed");
    expect(logs.some((m) => m.includes("kb down") && m.includes("降级原文执行"))).toBe(true);

    const opts = vi.mocked(runAgentTask).mock.calls[0]![0] as { task: { title: string; text: string }; capabilityInject: Record<string, unknown> };
    expect(opts.task.text).toBe("return 42;");
    expect(opts.capabilityInject["knowledge"]).toBeUndefined();
  });

  it("Task 4：注入 professional capability 且不覆盖 memory/skills/state", async () => {
    vi.mocked(runAgentTask).mockReset();
    vi.mocked(runAgentTask).mockResolvedValue({ ok: true, value: { done: true }, summary: "done", steps: 1 });

    const caps = {
      memory: { keep: true },
      skills: { keep: true },
      state: { keep: true },
    };
    const worker: WorkerReplicaRef = {
      workerId: "10000000-0000-4000-8000-000000000001",
      batchId: "batch-professional",
      role: { roleId: "assembly-engineer", revision: "rev-v1" },
    };
    const grant: ExecutionGrant = {
      grantId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6",
      nonce: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a7",
      lease: { taskId: lease.taskId, leaseId: lease.leaseId, generation: lease.generation },
      scope: {
        tenantId: "tenant-a",
        principalId: `worker:${worker.workerId}`,
        roles: [worker.role.roleId],
        traceId: scope.traceId,
        space: "meta",
      },
      workspace: lease.workspace,
      language: "ts",
      capabilities: ["professional.execute"],
      issuedAt: "2026-08-19T00:00:00.000Z",
      deadlineAt: "2026-08-19T00:01:00.000Z",
    };
    const professionalRegistry = {
      probe: vi.fn(),
      execute: vi.fn(),
      cancel: vi.fn(),
      register: vi.fn(),
    } as unknown as ProfessionalRuntimeRegistry;
    const professionalArtifacts: ProfessionalArtifactPort = {
      getInput: vi.fn(async () => new Uint8Array()),
      putOutput: vi.fn(async () => ({ kind: "out", uri: "artifact://tenant-a/out" })),
    };
    const professionalGrantService = {
      issue: vi.fn(() => grant),
      verify: vi.fn(),
    } as unknown as ExecutionGrantService;

    const { kernel } = fakeKernel();
    const runner = new AgentTaskRunner({
      kernel,
      role: { id: "assembly-engineer", tags: [], prompt: "assembly" },
      workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" },
      llm: fakeLlm,
      caps,
      config: { agentMode: true, aspMode: false },
      replica: worker,
      professionalRegistry,
      professionalArtifacts,
      professionalGrantService,
    });

    const outcome = await runner.run({ lease, work });

    expect(outcome.status).toBe("completed");
    expect(professionalGrantService.issue).toHaveBeenCalledWith({
      lease: { taskId: lease.taskId, leaseId: lease.leaseId, generation: lease.generation },
      scope: {
        tenantId: "tenant-a",
        principalId: `worker:${worker.workerId}`,
        roles: ["assembly-engineer"],
        traceId: scope.traceId,
        space: "meta",
      },
      workspace: lease.workspace,
      language: "ts",
      capabilities: ["professional.execute"],
      ttlMs: 1_800_000,
    });

    const opts = vi.mocked(runAgentTask).mock.calls[0]![0] as {
      caps: Record<string, unknown>;
      capabilityInject: Record<string, unknown>;
    };
    expect(opts.caps).toBe(caps); // 不覆盖既有 memory/skills/state
    const professional = opts.capabilityInject["professional"] as Record<string, unknown>;
    expect(professional).toBeDefined();
    expect(professional["probe"]).toBeTypeOf("function");
    expect(professional["execute"]).toBeTypeOf("function");
    expect(professional["cancel"]).toBeTypeOf("function");
  });
});
