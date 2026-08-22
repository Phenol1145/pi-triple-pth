import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AgentTaskRunner } from "../../src/pth/runner/agent-task-runner.js";
import {
  createProfessionalTaskCapability,
  type ProfessionalArtifactPort,
} from "../../src/pth/runner/professional-task-capability.js";
import { assembleProfessionalRuntimeRegistry } from "../../src/pth/bootstrap/professional-runtime-adapters.js";
import { createExecutionGrantService, createHmacGrantKeyProvider } from "../../src/pth/execution/index.js";
import type { ProfessionalRuntimeAdapter } from "../../src/pth/execution/professional-runtime.js";
import type {
  AssemblyJobSpec,
  ExecutionGrant,
  ProfessionalRuntimeLock,
  TaskLease,
  TaskWorkItem,
  TenantScope,
  WorkerReplicaRef,
} from "@away_from/pth-contracts";
import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";
import type { LlmFn } from "@away_from/pth-kernel-interpreter";
import type { RoleDefinition } from "@away_from/pth-kernel-execution";
import { roleDefinitionRevision } from "@away_from/pth-kernel-execution";
import { runAgentTask } from "@away_from/pth-kernel-execution";

vi.mock("@away_from/pth-kernel-execution", () => ({
  runAgentTask: vi.fn(),
}));

const scope: TenantScope = {
  tenantId: "tenant-a",
  principalId: "worker:10000000-0000-4000-8000-000000000001",
  roles: ["assembly-engineer"],
  traceId: "trace-professional",
  space: "dev",
};

const lease: TaskLease = {
  taskId: "task-1",
  leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6",
  generation: 1,
  scope,
  roleId: "assembly-engineer",
  workspace: { tenantId: "tenant-a", workspaceId: "ws-1", taskId: "task-1" },
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
};

const work: TaskWorkItem = {
  taskId: "task-1",
  scope,
  title: "professional task",
  text: "compute",
  tags: ["code"],
  payload: {},
  assignedRole: "assembly-engineer",
  domains: [],
};

const assemblySpec: AssemblyJobSpec = {
  operation: "build-run-disassemble",
  target: "x86-64",
  sourceRef: { kind: "source", uri: "artifact://tenant-a/assembly-source.s" },
};

function makeLock(): ProfessionalRuntimeLock {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-19T00:00:00.000Z",
    runtimes: {
      assembly: { version: "2.42", releaseChannel: "stable", probe: { tool: "as", args: ["--version"], extract: "[0-9]+\\.[0-9]+(\\.[0-9]+)?" } },
      lean4: { version: "4.8.0", releaseChannel: "stable", probe: { tool: "lean", args: ["--version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" } },
      wolfram: { version: "14.2.0", releaseChannel: "stable", probe: { tool: "wolframscript", args: ["-version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" } },
      psi4: { version: "1.9.1", releaseChannel: "stable", probe: { tool: "psi4", args: ["--version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" } },
      "quantum-espresso": { version: "7.4.1", releaseChannel: "stable", probe: { tool: "pw.x", args: ["--version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" } },
      jupyter: { version: "7.2.2", releaseChannel: "stable", probe: { tool: "jupyter-notebook", args: ["--version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" } },
    },
  };
}

function makeAdapter(
  runtimeId: "assembly" | "lean4",
  version: string,
  available: boolean,
): ProfessionalRuntimeAdapter<AssemblyJobSpec, { ok: boolean }> {
  const execute = vi.fn(async (input: { inputHash: string; traceId: string }) => ({
    status: "succeeded",
    runtime: runtimeId,
    runtimeVersion: version,
    inputHash: input.inputHash,
    outputHash: "sha256:" + "b".repeat(64),
    artifacts: [{ kind: "binary", uri: `artifact://tenant-a/out/${runtimeId}.o` }],
    diagnostics: [{ code: `${runtimeId}.ok`, severity: "info", message: "ok" }],
    usage: { durationMs: 1, cpuMs: 1, maxRssBytes: 1, outputBytes: 1 },
    traceId: input.traceId ?? scope.traceId,
    startedAt: "2026-08-19T10:00:00.000Z",
    finishedAt: "2026-08-19T10:00:01.000Z",
    value: { ok: true },
  }));
  return {
    id: runtimeId,
    probe: vi.fn(async () => ({ available, version, releaseChannel: "stable" as const })),
    execute,
    cancel: vi.fn(async () => true),
  } as unknown as ProfessionalRuntimeAdapter<AssemblyJobSpec, { ok: boolean }>;
}

function fakeKernel(): WorkerKernel {
  return {
    ts: {
      language: "ts",
      execute: async () => ({ ok: true, stdout: "", stderr: "", durationMs: 0, language: "ts" as const }),
      state: {},
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      reset() {},
      dispose() {},
    },
    bash: {
      language: "bash",
      execute: async () => ({ ok: true, stdout: "", stderr: "", durationMs: 0, language: "bash" as const }),
      state: {},
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      reset() {},
      dispose() {},
    },
    python: {
      language: "python",
      execute: async () => ({ ok: true, stdout: "", stderr: "", durationMs: 0, language: "python" as const }),
      state: {},
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      reset() {},
      dispose() {},
    },
    llm: null,
    dataWorld: null,
    reset: async () => {},
    snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
    dispose() {},
    abort: async () => {},
  } as unknown as WorkerKernel;
}

const fakeLlm: LlmFn = {
  complete: async () => ({ content: "{}" }),
};

const professionalRole: RoleDefinition = {
  id: "assembly-engineer",
  tags: ["assembly-engineer"],
  prompt: "assembly",
  capabilities: ["memory", "fs", "skills"],
  memoryScope: "own",
  actionTools: ["execTs", "nav", "cache"],
  output: "binary-artifact",
  defaultReads: ["context"],
  parent: "developer",
  generation: 4,
};
const worker: WorkerReplicaRef = {
  workerId: "10000000-0000-4000-8000-000000000001",
  batchId: "batch-professional",
  role: { roleId: "assembly-engineer", revision: roleDefinitionRevision(professionalRole) },
};

describe("professional capability integration (Task 4)", () => {
  it("assembleProfessionalRuntimeRegistry registers only probe-successful lock-matching adapters", async () => {
    const good = makeAdapter("assembly", "2.42", true);
    const bad = makeAdapter("lean4", "4.7.0", true);

    const registry = await assembleProfessionalRuntimeRegistry({
      lock: makeLock(),
      factories: {
        assembly: () => good,
        lean4: () => bad,
      },
    });

    await expect(registry.probe("assembly")).resolves.toMatchObject({ available: true, satisfiesLock: true });
    await expect(registry.probe("lean4")).resolves.toMatchObject({ available: false, reason: "unregistered-runtime" });
  });

  it("AgentTaskRunner injects a task-scoped professional capability that reaches the assembled adapter", async () => {
    vi.mocked(runAgentTask).mockReset();
    const adapter = makeAdapter("assembly", "2.42", true);
    const registry = await assembleProfessionalRuntimeRegistry({
      lock: makeLock(),
      factories: { assembly: () => adapter },
    });
    const artifacts: ProfessionalArtifactPort = {
      async getInput(_tenantId, artifact) {
        if (artifact.uri.includes("tenant-b")) throw new Error("artifact tenant mismatch: tenant-b != tenant-a");
        return new Uint8Array([1, 2, 3]);
      },
      async putOutput(input) {
        return { kind: input.kind, uri: `artifact://${input.tenantId}/${input.jobId}/${input.kind}` };
      },
    };
    const grantService = createExecutionGrantService({
      keyProvider: createHmacGrantKeyProvider({ secret: "professional-integration-secret-0123456789" }),
    });

    const professionalRegistry = registry;
    const caps = { memory: { keep: true }, skills: { keep: true }, state: { keep: true } };

    vi.mocked(runAgentTask).mockImplementation(async (input) => {
      const injected = (input as unknown as { capabilityInject: Record<string, unknown> }).capabilityInject;
      const professional = injected["professional"] as ReturnType<typeof createProfessionalTaskCapability>;
      const handle = await professional.execute({ runtimeId: "assembly", spec: assemblySpec });
      return { ok: true, value: handle, summary: "professional ok", steps: 1 };
    });

    const runner = new AgentTaskRunner({
      kernel: fakeKernel(),
      role: professionalRole,
      workspace: { taskId: "task-1", tenant: "tenant-a", dir: "/tmp/task-1" },
      llm: fakeLlm,
      caps,
      config: { agentMode: true, aspMode: false },
      replica: worker,
      professionalRegistry,
      professionalArtifacts: artifacts,
      professionalGrantService: grantService,
    });

    const outcome = await runner.run({ lease, work });

    expect(outcome.status).toBe("completed");
    const handle = (outcome.result as { value?: { result?: { status?: string; traceId?: string; artifacts?: Array<{ uri: string }> } } })?.value;
    expect(handle?.result?.status).toBe("succeeded");
    expect(handle?.result?.traceId).toBe(scope.traceId);
    expect(handle?.result?.artifacts?.[0]?.uri).toMatch(/^artifact:\/\/tenant-a\//);

    const opts = vi.mocked(runAgentTask).mock.calls[0]![0] as { caps: Record<string, unknown>; capabilityInject: Record<string, unknown> };
    expect(opts.caps).toBe(caps);
    expect(opts.capabilityInject["professional"]).toBeDefined();
  });
});
