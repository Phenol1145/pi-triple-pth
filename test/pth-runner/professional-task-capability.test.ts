import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createProfessionalTaskCapability,
  PROFESSIONAL_MAX_OUTPUT_BYTES,
  type ProfessionalArtifactPort,
  type ProfessionalTaskCapabilityInput,
} from "../../src/pth/runner/professional-task-capability.js";
import {
  createProfessionalRuntimeRegistry,
  type ProfessionalRuntimeAdapter,
} from "../../src/pth/execution/professional-runtime.js";
import { roleDefinitionRevision } from "@away_from/pth-kernel-execution";
import type { RoleDefinition } from "@away_from/pth-kernel-execution";
import type {
  AssemblyJobSpec,
  ExecutionGrant,
  ProfessionalRuntimeLock,
  TaskLease,
  TaskWorkItem,
  TenantScope,
  WorkerReplicaRef,
} from "@away_from/pth-contracts";

/**
 * Task 4 / Step 1: denial-before-backing-call tests.
 *
 * 每个 denial 用例都断言：
 *   1. `adapter.execute` 调用数为 0（先于 backing call 拒绝）；
 *   2. 返回结构化 failed 结果，diagnostics[0].code 为机器可读 reason code。
 */

const NOW = new Date("2026-08-19T10:00:00.000Z");

const scope: TenantScope = {
  tenantId: "tenant-a",
  principalId: "worker:10000000-0000-4000-8000-000000000001",
  roles: ["assembly-engineer"],
  traceId: "trace-professional",
  space: "dev",
};

function makeLease(overrides: Partial<TaskLease> = {}): TaskLease {
  return {
    taskId: "task-1",
    leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6",
    generation: 1,
    scope,
    roleId: "assembly-engineer",
    workspace: { tenantId: "tenant-a", workspaceId: "ws-1", taskId: "task-1" },
    deadlineAt: new Date(NOW.getTime() + 60_000).toISOString(),
    ...overrides,
  };
}

function makeWork(overrides: Partial<TaskWorkItem> = {}): TaskWorkItem {
  return {
    taskId: "task-1",
    scope,
    title: "professional task",
    text: "compute",
    tags: ["code"],
    payload: {},
    assignedRole: "assembly-engineer",
    domains: [],
    ...overrides,
  };
}

function makeRole(roleId: string): RoleDefinition {
  return {
    id: roleId,
    tags: [roleId],
    prompt: `prompt for ${roleId}`,
    description: roleId,
    capabilities: ["memory", "fs", "skills"],
    memoryScope: "own",
    actionTools: ["execTs", "nav", "cache"],
    output: "artifact",
    defaultReads: ["context"],
    parent: "developer",
    generation: 3,
  };
}

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

const assemblySpec: AssemblyJobSpec = {
  operation: "build-run-disassemble",
  target: "x86-64",
  sourceRef: { kind: "source", uri: "artifact://tenant-a/assembly-source.s" },
};

function makeHarness(opts: {
  roleId?: string;
  workerRevision?: string;
  leaseDeadlineAt?: string;
  grantPrincipalId?: string;
  grantCapabilities?: string[];
  getInput?: ProfessionalArtifactPort["getInput"];
} = {}) {
  const roleId = opts.roleId ?? "assembly-engineer";
  const role = makeRole(roleId);
  const computedRevision = roleDefinitionRevision(role);
  const worker: WorkerReplicaRef = {
    workerId: "10000000-0000-4000-8000-000000000001",
    batchId: "batch-professional",
    role: { roleId, revision: opts.workerRevision ?? computedRevision },
  };
  const lease = makeLease(opts.leaseDeadlineAt ? { deadlineAt: opts.leaseDeadlineAt } : {});
  const grant: ExecutionGrant = {
    grantId: randomUUID(),
    nonce: randomUUID(),
    lease: { taskId: lease.taskId, leaseId: lease.leaseId, generation: lease.generation },
    scope: {
      tenantId: "tenant-a",
      principalId: opts.grantPrincipalId ?? `worker:${worker.workerId}`,
      roles: [roleId],
      traceId: scope.traceId,
      space: "dev",
    },
    workspace: lease.workspace,
    language: "ts",
    capabilities: opts.grantCapabilities ?? ["professional.execute"],
    issuedAt: "2026-08-19T09:59:00.000Z",
    deadlineAt: "2026-08-19T10:01:00.000Z",
  };

  const adapter: ProfessionalRuntimeAdapter<AssemblyJobSpec, { ok: boolean }> & {
    execute: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  } = {
    id: "assembly",
    probe: vi.fn(async () => ({ available: true, version: "2.42", releaseChannel: "stable" })),
    execute: vi.fn(async () => ({
      status: "succeeded",
      runtime: "assembly",
      runtimeVersion: "2.42",
      inputHash: "sha256:" + "a".repeat(64),
      outputHash: "sha256:" + "b".repeat(64),
      artifacts: [{ kind: "binary", uri: "artifact://tenant-a/out.o" }],
      diagnostics: [{ code: "assembly.ok", severity: "info", message: "ok" }],
      usage: { durationMs: 1, cpuMs: 1, maxRssBytes: 1, outputBytes: 1 },
      traceId: scope.traceId,
      startedAt: "2026-08-19T10:00:00.000Z",
      finishedAt: "2026-08-19T10:00:01.000Z",
      value: { ok: true },
    })),
    cancel: vi.fn(async () => true),
  };
  const registry = createProfessionalRuntimeRegistry({ lock: makeLock(), clock: () => NOW });
  registry.register(adapter as ProfessionalRuntimeAdapter<AssemblyJobSpec, { ok: boolean }>);

  const artifacts: ProfessionalArtifactPort = {
    async getInput(_tenantId, artifact) {
      if (artifact.uri.includes("tenant-b")) {
        throw new Error("artifact tenant mismatch: tenant-b != tenant-a");
      }
      return new Uint8Array([1, 2, 3]);
    },
    async putOutput(input) {
      return { kind: input.kind, uri: `artifact://${input.tenantId}/${input.jobId}/${input.kind}` };
    },
  };
  artifacts.getInput = opts.getInput ?? artifacts.getInput;

  const input: ProfessionalTaskCapabilityInput = {
    lease,
    work: makeWork(),
    worker,
    role,
    grant,
    registry,
    artifacts,
    space: "dev",
    clock: () => NOW,
  };
  const capability = createProfessionalTaskCapability(input);
  return { adapter, capability, worker, lease, grant };
}

describe("professional task capability: denial before backing call", () => {
  it("denies a wrong role revision before calling the adapter", async () => {
    const { adapter, capability } = makeHarness({
      workerRevision: "role-sha256:" + "1".repeat(64),
    });

    const handle = await capability.execute({ runtimeId: "assembly", spec: assemblySpec });

    expect(handle.result.status).toBe("failed");
    expect(handle.result.diagnostics[0]?.code).toBe("role-revision-mismatch");
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("denies an expired task lease before calling the adapter", async () => {
    const { adapter, capability } = makeHarness({
      leaseDeadlineAt: new Date(NOW.getTime() - 1).toISOString(),
    });

    const handle = await capability.execute({ runtimeId: "assembly", spec: assemblySpec });

    expect(handle.result.status).toBe("failed");
    expect(handle.result.diagnostics[0]?.code).toBe("lease-expired");
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("denies a runtime outside the role allowlist before calling the adapter", async () => {
    const { adapter, capability } = makeHarness({ roleId: "technical-educator" });

    const handle = await capability.execute({ runtimeId: "assembly", spec: assemblySpec });

    expect(handle.result.status).toBe("failed");
    expect(handle.result.diagnostics[0]?.code).toBe("runtime-not-allowed");
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("denies an input artifact from another tenant before calling the adapter", async () => {
    const { adapter, capability } = makeHarness();

    const handle = await capability.execute({
      runtimeId: "assembly",
      spec: assemblySpec,
      inputs: [{ kind: "source", uri: "artifact://tenant-b/foreign.s" }],
    });

    expect(handle.result.status).toBe("failed");
    expect(handle.result.diagnostics[0]?.code).toBe("tenant-mismatch");
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("denies output over the limit before calling the adapter", async () => {
    const { adapter, capability } = makeHarness();

    const handle = await capability.execute({
      runtimeId: "assembly",
      spec: assemblySpec,
      outputs: [{ kind: "result", mediaType: "application/octet-stream", maxBytes: PROFESSIONAL_MAX_OUTPUT_BYTES + 1 }],
    });

    expect(handle.result.status).toBe("failed");
    expect(handle.result.diagnostics[0]?.code).toBe("output-limit");
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});

describe("professional task capability: success, cancel and trace/artifact binding", () => {
  it("executes through the backing adapter with server-stamped identity and tenant-scoped artifacts", async () => {
    const { adapter, capability, worker, lease, grant } = makeHarness();

    const handle = await capability.execute({ runtimeId: "assembly", spec: assemblySpec });

    expect(handle.jobId).toBeTruthy();
    expect(handle.result.status).toBe("succeeded");
    expect(adapter.execute).toHaveBeenCalledTimes(1);

    const request = adapter.execute.mock.calls[0]![0] as {
      tenantId: string;
      space: string;
      worker: WorkerReplicaRef;
      lease: { taskId: string; leaseId: string; generation: number };
      roleRevision: string;
      runtimeId: string;
      runtimeVersion: string;
      deadlineAt: string;
      traceId: string;
    };
    expect(request.tenantId).toBe("tenant-a");
    expect(request.space).toBe("dev");
    expect(request.worker).toEqual(worker);
    expect(request.lease).toEqual({ taskId: lease.taskId, leaseId: lease.leaseId, generation: lease.generation });
    expect(request.roleRevision).toBe(worker.role.revision);
    expect(request.runtimeId).toBe("assembly");
    expect(request.runtimeVersion).toBe("lock:assembly");
    expect(request.deadlineAt).toBe(lease.deadlineAt); // lease deadline earlier than grant
    expect(request.traceId).toBe(scope.traceId);

    expect(handle.result.traceId).toBe(scope.traceId);
    expect(handle.result.artifacts[0]?.uri).toMatch(/^artifact:\/\/tenant-a\//);
  });

  it("makes cancel idempotent through the backing adapter", async () => {
    const { adapter, capability } = makeHarness();

    const handle = await capability.execute({ runtimeId: "assembly", spec: assemblySpec });

    await expect(capability.cancel({ runtimeId: "assembly", jobId: handle.jobId })).resolves.toBe(true);
    await expect(capability.cancel({ runtimeId: "assembly", jobId: handle.jobId })).resolves.toBe(true);

    expect(adapter.cancel).toHaveBeenCalledTimes(2);
  });

  it("denies a worker id that does not match the grant principal", async () => {
    const { adapter, capability } = makeHarness({
      grantPrincipalId: "worker:10000000-0000-4000-8000-0000000000ff",
    });

    const handle = await capability.execute({ runtimeId: "assembly", spec: assemblySpec });

    expect(handle.result.status).toBe("failed");
    expect(handle.result.diagnostics[0]?.code).toBe("worker-mismatch");
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
