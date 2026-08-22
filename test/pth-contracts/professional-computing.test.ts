import { describe, expect, it } from "vitest";
import {
  isProfessionalJobResultStructurallyValid,
  validateProfessionalJobRequest,
  type ArtifactRef,
  type AssemblyJobSpec,
  type JupyterJobSpec,
  type Lean4JobSpec,
  type ProfessionalJobRequest,
  type ProfessionalJobResult,
  type Psi4JobSpec,
  type QuantumEspressoJobSpec,
  type TaskLeaseReference,
  type WolframJobSpec,
  type WorkerReplicaRef,
} from "@away_from/pth-contracts";

const artifact: ArtifactRef = {
  kind: "source",
  uri: "artifact://tenant-a/assembly-source",
};

const worker: WorkerReplicaRef = {
  workerId: "10000000-0000-4000-8000-0000000000a1",
  batchId: "batch-professional",
  role: { roleId: "assembly-engineer", revision: "rev-v1" },
};

const lease: TaskLeaseReference = {
  taskId: "task-1",
  leaseId: "20000000-0000-4000-8000-0000000000a1",
  generation: 1,
};

function makeRequest<S>(
  runtimeId: ProfessionalJobRequest<S>["runtimeId"],
  spec: S,
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
  };
}

describe("professional-computing contract (v1.3 Task 2)", () => {
  it("accepts the six discriminated job specs with matching runtimeId", () => {
    const assemblySpec: AssemblyJobSpec = {
      operation: "build-run-disassemble",
      target: "riscv64",
      sourceRef: artifact,
    };
    const lean4Spec: Lean4JobSpec = {
      operation: "lake-build",
      projectRef: artifact,
    };
    const wolframSpec: WolframJobSpec = {
      operation: "evaluate",
      expression: "2 + 2",
    };
    const psi4Spec: Psi4JobSpec = {
      operation: "single-point",
      molecule: {
        geometry: [
          ["H", 0, 0, 0],
          ["H", 0, 0, 0.74],
        ],
        charge: 0,
        multiplicity: 1,
      },
      method: "hf",
      basis: "sto-3g",
    };
    const qeSpec: QuantumEspressoJobSpec = {
      operation: "scf",
      structureRef: artifact,
      pseudopotentials: { Si: "Si.pbe-n-rrkjus_psl.1.0.0.UPF" },
    };
    const jupyterSpec: JupyterJobSpec = {
      operation: "execute",
      notebookRef: artifact,
      kernel: "python3",
    };

    const cases = [
      makeRequest("assembly", assemblySpec),
      makeRequest("lean4", lean4Spec),
      makeRequest("wolfram", wolframSpec),
      makeRequest("psi4", psi4Spec),
      makeRequest("quantum-espresso", qeSpec),
      makeRequest("jupyter", jupyterSpec),
    ] as const;

    for (const request of cases) {
      expect(validateProfessionalJobRequest(request).ok).toBe(true);
    }
  });

  it("rejects any command field inside a job spec", () => {
    const request = makeRequest("assembly", {
      operation: "build-run-disassemble",
      target: "riscv64",
      sourceRef: artifact,
    } satisfies AssemblyJobSpec);

    expect(validateProfessionalJobRequest({ ...request, spec: { command: "bash -lc env" } }).ok).toBe(false);
  });

  it("rejects a missing lease", () => {
    const request = makeRequest("assembly", {
      operation: "build-run-disassemble",
      target: "riscv64",
      sourceRef: artifact,
    } satisfies AssemblyJobSpec);
    const { lease: _lease, ...withoutLease } = request;

    expect(validateProfessionalJobRequest(withoutLease).ok).toBe(false);
  });

  it("rejects a missing deadlineAt", () => {
    const request = makeRequest("assembly", {
      operation: "build-run-disassemble",
      target: "riscv64",
      sourceRef: artifact,
    } satisfies AssemblyJobSpec);
    const { deadlineAt: _deadlineAt, ...withoutDeadline } = request;

    expect(validateProfessionalJobRequest(withoutDeadline).ok).toBe(false);
  });

  it("rejects a missing inputHash", () => {
    const request = makeRequest("assembly", {
      operation: "build-run-disassemble",
      target: "riscv64",
      sourceRef: artifact,
    } satisfies AssemblyJobSpec);
    const { inputHash: _inputHash, ...withoutInputHash } = request;

    expect(validateProfessionalJobRequest(withoutInputHash).ok).toBe(false);
  });

  it("accepts the common result envelope with status/runtime/version/hashes/artifacts/diagnostics/usage/traceId/timestamps", () => {
    const result: ProfessionalJobResult<{ cycles: number }> = {
      status: "succeeded",
      runtime: "assembly",
      runtimeVersion: "2.42",
      inputHash: "sha256:" + "b".repeat(64),
      outputHash: "sha256:" + "c".repeat(64),
      artifacts: [{ kind: "binary", uri: "artifact://tenant-a/out/riscv64.o" }],
      diagnostics: [{ code: "assembly.ok", severity: "info", message: "build-run-disassemble succeeded" }],
      usage: { durationMs: 12, cpuMs: 10, maxRssBytes: 1024, outputBytes: 2048 },
      traceId: "trace-professional-1",
      startedAt: "2030-01-01T00:00:00.000Z",
      finishedAt: "2030-01-01T00:00:12.000Z",
      value: { cycles: 3 },
    };

    expect(isProfessionalJobResultStructurallyValid(result)).toBe(true);
  });

  it("rejects a result envelope that carries an executable callback or a raw secret", () => {
    const base: ProfessionalJobResult = {
      status: "succeeded",
      runtime: "assembly",
      runtimeVersion: "2.42",
      inputHash: "sha256:" + "b".repeat(64),
      outputHash: "sha256:" + "c".repeat(64),
      artifacts: [],
      diagnostics: [],
      usage: { durationMs: 0, cpuMs: 0, maxRssBytes: 0, outputBytes: 0 },
      traceId: "trace-professional-1",
      startedAt: "2030-01-01T00:00:00.000Z",
      finishedAt: "2030-01-01T00:00:01.000Z",
    };

    expect(isProfessionalJobResultStructurallyValid({ ...base, value: () => "callback" })).toBe(false);
    expect(isProfessionalJobResultStructurallyValid({ ...base, secret: "raw-token" })).toBe(false);
  });
});
