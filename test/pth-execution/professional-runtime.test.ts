import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createProfessionalJobAuthVerifier,
  createProfessionalRuntimeRegistry,
  type ProfessionalRuntimeAdapter,
  type ProfessionalRuntimeRegistry,
} from "../../src/pth/execution/professional-runtime.js";
import { createExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import type {
  ArtifactRef,
  AssemblyJobSpec,
  ExecutionGrant,
  Lean4JobSpec,
  ProfessionalJobRequest,
  ProfessionalJobResult,
  ProfessionalJobSpec,
  ProfessionalRuntimeLock,
  TaskLeaseReference,
  WorkerReplicaRef,
} from "@away_from/pth-contracts";

let nowMs = Date.parse("2030-01-01T00:00:00.000Z");
const clock = () => new Date(nowMs);

const artifact: ArtifactRef = { kind: "source", uri: "artifact://tenant-a/assembly-source" };

const worker: WorkerReplicaRef = {
  workerId: "10000000-0000-4000-8000-0000000000b1",
  batchId: "batch-professional",
  role: { roleId: "assembly-engineer", revision: "rev-v1" },
};

const lease: TaskLeaseReference = {
  taskId: "task-1",
  leaseId: randomUUID(),
  generation: 1,
};

const assemblySpec: AssemblyJobSpec = {
  operation: "build-run-disassemble",
  target: "riscv64",
  sourceRef: artifact,
};

const lean4Spec: Lean4JobSpec = {
  operation: "lake-build",
  projectRef: artifact,
};

function makeRequest<S extends ProfessionalJobSpec>(
  runtimeId: ProfessionalJobRequest<S>["runtimeId"],
  spec: S,
  overrides: Partial<ProfessionalJobRequest<S>> = {},
): ProfessionalJobRequest<S> {
  return {
    jobId: "job-1",
    taskId: "task-1",
    tenantId: "tenant-a",
    space: "dev",
    worker,
    lease,
    roleRevision: worker.role.revision,
    runtimeId,
    runtimeVersion: `lock:${runtimeId}`,
    deadlineAt: "2030-01-01T00:01:00.000Z",
    inputHash: "sha256:" + "b".repeat(64),
    spec,
    ...overrides,
  };
}

const key = createHmacGrantKeyProvider({ secret: "professional-runtime-test-secret-0123456789" });

function makeGrantService() {
  return createExecutionGrantService({ keyProvider: key, clock });
}

function issueGrant(
  svc: ReturnType<typeof makeGrantService>,
  request: ProfessionalJobRequest<any>,
  overrides: Partial<Parameters<ReturnType<typeof makeGrantService>["issue"]>[0]> = {},
): ExecutionGrant {
  return svc.issue({
    lease: request.lease,
    scope: {
      tenantId: request.tenantId,
      principalId: `worker:${request.worker.workerId}`,
      roles: [request.worker.role.roleId],
      traceId: "trace-professional",
      space: request.space,
    },
    workspace: { tenantId: request.tenantId, workspaceId: "ws-opaque", taskId: request.taskId },
    language: "ts",
    capabilities: ["professional.execute"],
    ttlMs: 120_000,
    ...overrides,
  });
}

function makeAuth(request: ProfessionalJobRequest<any>, svc: ReturnType<typeof makeGrantService>) {
  const grant = issueGrant(svc, request);
  const verifier = createProfessionalJobAuthVerifier({ grantService: svc });
  return { grant, auth: verifier.verify(request, grant, { leaseDeadlineAt: "2030-01-01T00:02:00.000Z" }) };
}

function makeLock(): ProfessionalRuntimeLock {
  return {
    schemaVersion: 1,
    generatedAt: "2029-12-31T00:00:00.000Z",
    runtimes: {
      assembly: { version: "2.42", releaseChannel: "stable", probe: { tool: "as", args: ["--version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" } },
      lean4: { version: "4.8.0", releaseChannel: "stable", probe: { tool: "lean", args: ["--version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" } },
      wolfram: { version: "14.2.0", releaseChannel: "stable", probe: { tool: "wolframscript", args: ["-version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" } },
      psi4: { version: "1.9.1", releaseChannel: "stable", probe: { tool: "psi4", args: ["--version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" } },
      "quantum-espresso": { version: "7.4.1", releaseChannel: "stable", probe: { tool: "pw.x", args: ["--version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" } },
      jupyter: { version: "7.2.2", releaseChannel: "stable", probe: { tool: "jupyter-notebook", args: ["--version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" } },
    },
  };
}

function makeAdapter(overrides: Partial<ProfessionalRuntimeAdapter<AssemblyJobSpec, { ok: boolean }>> = {}): ProfessionalRuntimeAdapter<AssemblyJobSpec, { ok: boolean }> {
  return {
    id: "assembly",
    probe: async () => ({ available: true, version: "2.42", releaseChannel: "stable" }),
    execute: async (input) => ({
      status: "succeeded",
      runtime: "assembly",
      runtimeVersion: "2.42",
      inputHash: input.inputHash,
      outputHash: "sha256:" + "d".repeat(64),
      artifacts: [{ kind: "binary", uri: "artifact://tenant-a/out/riscv64.o" }],
      diagnostics: [{ code: "assembly.ok", severity: "info", message: "ok" }],
      usage: { durationMs: 1, cpuMs: 1, maxRssBytes: 1, outputBytes: 1 },
      traceId: input.traceId ?? "trace-professional",
      startedAt: "2030-01-01T00:00:00.000Z",
      finishedAt: "2030-01-01T00:00:01.000Z",
      value: { ok: true },
    }),
    cancel: async () => true,
    ...overrides,
  };
}

function makeRegistry(lock = makeLock()): ProfessionalRuntimeRegistry {
  return createProfessionalRuntimeRegistry({ lock, clock });
}

describe("professional runtime registry (v1.3 Task 2)", () => {
  it("rejects a duplicate adapter id at register time", () => {
    const registry = makeRegistry();
    registry.register(makeAdapter());

    expect(() => registry.register(makeAdapter())).toThrow(/duplicate adapter id/);
  });

  it("rejects an adapter whose id is not an allowlisted professional runtime", () => {
    const registry = makeRegistry();

    expect(() =>
      registry.register({ ...makeAdapter(), id: "bash" } as unknown as ProfessionalRuntimeAdapter),
    ).toThrow(/not an allowlisted professional runtime/);
  });

  it("rejects an unregistered runtime with a structured result", async () => {
    const registry = makeRegistry();
    registry.register(makeAdapter());
    const svc = makeGrantService();
    const lean4Worker: WorkerReplicaRef = {
      workerId: "10000000-0000-4000-8000-0000000000b3",
      batchId: "batch-professional",
      role: { roleId: "lean4-prover", revision: "rev-v1" },
    };
    const request: ProfessionalJobRequest<Lean4JobSpec> = {
      ...makeRequest("lean4", lean4Spec),
      worker: lean4Worker,
      roleRevision: "rev-v1",
    };
    const { auth } = makeAuth(request, svc);

    const result = await registry.execute(request, auth);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("unregistered-runtime");
    expect(result.runtime).toBe("lean4");
    expect(result.artifacts).toEqual([]);
  });

  it("rejects a role that is not in the runtime allowlist", async () => {
    const registry = makeRegistry();
    registry.register(makeAdapter());
    const svc = makeGrantService();
    const researcherWorker: WorkerReplicaRef = {
      workerId: "10000000-0000-4000-8000-0000000000b2",
      batchId: "batch-professional",
      role: { roleId: "researcher", revision: "rev-researcher" },
    };
    const request: ProfessionalJobRequest<AssemblyJobSpec> = {
      ...makeRequest("assembly", assemblySpec),
      worker: researcherWorker,
      roleRevision: "rev-researcher",
    };
    const { auth } = makeAuth(request, svc);

    const result = await registry.execute(request, auth);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("role-not-allowed");
  });

  it("rejects an expired deadline before invoking the adapter", async () => {
    const registry = makeRegistry();
    const execute = vi.fn(async (input: ProfessionalJobRequest<AssemblyJobSpec>) => {
      throw new Error("adapter must not be reached");
    });
    registry.register(makeAdapter({ execute: execute as never }));
    const svc = makeGrantService();
    const request = makeRequest("assembly", assemblySpec, { deadlineAt: "2029-12-31T23:59:59.000Z" });
    const { auth } = makeAuth(request, svc);

    const result = await registry.execute(request, auth);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("deadline-exceeded");
    expect(execute).not.toHaveBeenCalled();
  });

  it("makes cancel idempotent through the adapter", async () => {
    const cancel = vi.fn(async () => true);
    const registry = makeRegistry();
    registry.register(makeAdapter({ cancel }));
    const svc = makeGrantService();
    const request = makeRequest("assembly", assemblySpec);
    const { auth } = makeAuth(request, svc);

    await expect(registry.cancel("assembly", "job-1", auth)).resolves.toBe(true);
    await expect(registry.cancel("assembly", "job-1", auth)).resolves.toBe(true);

    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("rejects a committed lock entry that is not stable", async () => {
    const badLock = {
      ...makeLock(),
      runtimes: {
        ...makeLock().runtimes,
        assembly: {
          version: "2.42",
          releaseChannel: "nightly",
          probe: { tool: "as", args: ["--version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" },
        },
      },
    } as unknown as ProfessionalRuntimeLock;
    const registry = makeRegistry(badLock);
    registry.register(makeAdapter());
    const svc = makeGrantService();
    const request = makeRequest("assembly", assemblySpec);
    const { auth } = makeAuth(request, svc);

    const result = await registry.execute(request, auth);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("lock-entry-not-stable");
  });

  it("rejects an installed version that does not match the committed lock", async () => {
    const registry = makeRegistry();
    registry.register(makeAdapter({ probe: async () => ({ available: true, version: "2.41", releaseChannel: "stable" }) }));
    const svc = makeGrantService();
    const request = makeRequest("assembly", assemblySpec);
    const { auth } = makeAuth(request, svc);

    const result = await registry.execute(request, auth);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("installed-version-mismatch");
  });

  it("rejects an auth bound to a different lease", async () => {
    const registry = makeRegistry();
    registry.register(makeAdapter());
    const svc = makeGrantService();
    const request = makeRequest("assembly", assemblySpec);
    const { auth } = makeAuth(request, svc);
    const otherRequest = makeRequest("assembly", assemblySpec, {
      lease: { taskId: "task-other", leaseId: randomUUID(), generation: 1 },
    });

    const result = await registry.execute(otherRequest, auth);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("auth-rejected");
  });

  it("returns a valid adapter result on the happy path", async () => {
    const registry = makeRegistry();
    registry.register(makeAdapter());
    const svc = makeGrantService();
    const request = makeRequest("assembly", assemblySpec);
    const { auth } = makeAuth(request, svc);

    const result = await registry.execute(request, auth);

    expect(result.status).toBe("succeeded");
    expect(result.runtime).toBe("assembly");
    expect(result.runtimeVersion).toBe("2.42");
    expect(result.traceId).toBe("trace-professional");
    expect(result.artifacts).toHaveLength(1);
  });

  it("turns an adapter error into a structured result", async () => {
    const registry = makeRegistry();
    registry.register(makeAdapter({
      execute: async () => {
        throw new Error("adapter exploded");
      },
    } as Partial<ProfessionalRuntimeAdapter<AssemblyJobSpec, { ok: boolean }>>));
    const svc = makeGrantService();
    const request = makeRequest("assembly", assemblySpec);
    const { auth } = makeAuth(request, svc);

    const result: ProfessionalJobResult<{ ok: boolean }> = await registry.execute(request, auth);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("adapter-error");
    expect(result.diagnostics[0]?.severity).toBe("error");
    expect(result.artifacts).toEqual([]);
  });
});
