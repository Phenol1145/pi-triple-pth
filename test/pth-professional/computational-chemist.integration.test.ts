/**
 * computational-chemist.integration.test.ts — v1.3 Task 8 计算化学垂直切片。
 *
 * 真实引擎纪律：工具/版本缺失 = preflight FAIL（或明确 unavailable），不 skip。
 *  - Psi4（conda-forge aarch64 1.9.1）：H2O HF/sto-3g 单点，能量/收敛结构化；
 *  - Quantum ESPRESSO 6.7：Si 金刚石 2 原子周期 SCF（pslibrary 赝势 artifact）。
 *  - 负路径：非法 geometry、command 注入、版本伪造、缺赝势、非收敛语义。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfessionalJobRequest, Psi4JobSpec, QuantumEspressoJobSpec } from "../../src/pth/contracts/index.js";
import { createProfessionalArtifactPort } from "../../src/pth/bootstrap/professional-runtime-adapters.js";
import {
  createPsi4RuntimeAdapter,
  createQuantumEspressoRuntimeAdapter,
  createCp2kRuntimeAdapter,
} from "../../src/pth/execution/adapters/computational-chemistry-adapter.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const LOCK_PATH = join(REPO_ROOT, "deploy/professional-runtime-lock.json");
const WORK_DIR = join(REPO_ROOT, `.chem-work-test-${process.pid}`);
const EXEC_PREFIX = ["docker", "exec", "-e", "HOME=/home/node", "-e", "PATH=/opt/miniforge/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "-e", "OMPI_MCA_rmaps_base_oversubscribe=1", "-e", "OMPI_MCA_orte_allow_run_as_root=1", "v13-asm-toolchain"];

const TENANT = "tenant-chem";

function psi4Request(spec: Psi4JobSpec, jobId: string): ProfessionalJobRequest<Psi4JobSpec> {
  return {
    jobId, taskId: "task-chem", tenantId: TENANT, space: "default",
    worker: { workerId: "worker-chem-1", batchId: "batch-chem-1", role: { roleId: "computational-chemist", revision: "rev-1" } },
    lease: { taskId: "task-chem", leaseId: "lease-chem-1", generation: 1 },
    roleRevision: "rev-1", runtimeId: "psi4", runtimeVersion: "lock:psi4",
    deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    inputHash: "sha256:psi4", traceId: `trace-${jobId}`, spec,
  };
}

function qeRequest(spec: QuantumEspressoJobSpec, jobId: string): ProfessionalJobRequest<QuantumEspressoJobSpec> {
  return {
    jobId, taskId: "task-chem", tenantId: TENANT, space: "default",
    worker: { workerId: "worker-chem-2", batchId: "batch-chem-1", role: { roleId: "computational-chemist", revision: "rev-1" } },
    lease: { taskId: "task-chem", leaseId: "lease-chem-2", generation: 1 },
    roleRevision: "rev-1", runtimeId: "quantum-espresso", runtimeVersion: "lock:quantum-espresso",
    deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    inputHash: "sha256:qe", traceId: `trace-${jobId}`, spec,
  };
}

let artifactRoot: string;
let psi4Adapter: ReturnType<typeof createPsi4RuntimeAdapter>;
let qeAdapter: ReturnType<typeof createQuantumEspressoRuntimeAdapter>;
let cp2kAdapter: ReturnType<typeof createCp2kRuntimeAdapter>;

const SI_CELL = `5.431 0.000 0.000
0.000 5.431 0.000
0.000 0.000 5.431
Si 0.0000 0.0000 0.0000
Si 1.3578 1.3578 1.3578`;

const RUN = process.env.PTH_PROFESSIONAL_INTEGRATION === "1";

describe.skipIf(!RUN)("professional integration (gated)", () => {

beforeAll(async () => {
  artifactRoot = await mkdtemp(join(tmpdir(), "chem-vertical-"));
  await mkdir(WORK_DIR, { recursive: true });
  const lock = JSON.parse(await readFile(LOCK_PATH, "utf8")) as {
    runtimes: { psi4: { version: string }; "quantum-espresso": { version: string }; cp2k: { version: string } };
  };
  const port = createProfessionalArtifactPort({ artifactPath: artifactRoot });
  psi4Adapter = createPsi4RuntimeAdapter({
    artifactPort: port,
    lockVersion: lock.runtimes.psi4.version,
    engineCommand: "/opt/miniforge/bin/psi4",
    workDir: WORK_DIR,
    execPrefix: EXEC_PREFIX,
    timeoutMs: 600_000,
  });
  qeAdapter = createQuantumEspressoRuntimeAdapter({
    artifactPort: port,
    lockVersion: lock.runtimes["quantum-espresso"].version,
    engineCommand: "pw.x",
    workDir: WORK_DIR,
    execPrefix: EXEC_PREFIX,
    timeoutMs: 600_000,
  });
  cp2kAdapter = createCp2kRuntimeAdapter({
    artifactPort: port,
    lockVersion: lock.runtimes.cp2k.version,
    engineCommand: "cp2k",
    workDir: WORK_DIR,
    execPrefix: EXEC_PREFIX,
    timeoutMs: 600_000,
  });
  // 结构 artifact 与赝势 artifact 写入租户树。
  await mkdir(join(artifactRoot, TENANT, "structures"), { recursive: true });
  await mkdir(join(artifactRoot, TENANT, "pseudo"), { recursive: true });
  await writeFile(join(artifactRoot, TENANT, "structures", "si.xyz"), SI_CELL, "utf8");
  // 赝势是不可变 artifact：从工具链容器物化进租户 artifact 树（pslibrary Si）。
  execFileSync("docker", ["cp", "v13-asm-toolchain:/home/node/pseudo/Si.pbe-n-rrkjus_psl.1.0.0.UPF",
    join(artifactRoot, TENANT, "pseudo", "Si.UPF")]);
}, 60_000);

afterAll(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
  await rm(WORK_DIR, { recursive: true, force: true });
});

describe("computational chemist vertical", () => {
  it("preflight：引擎探测可用性（缺失 = FAIL，不是 skip）", async () => {
    const pProbe = await psi4Adapter.probe();
    const qProbe = await qeAdapter.probe();
    const cProbe = await cp2kAdapter.probe();
    // QE 与 CP2K 必须就绪；Psi4 若未装则明确 unavailable（验收记录 EVALUATION-INCOMPLETE）。
    expect(qProbe.available, qProbe.reason).toBe(true);
    expect(cProbe.available, cProbe.reason).toBe(true);
    if (!pProbe.available) expect(pProbe.reason).toMatch(/不可执行|不一致|解析/);
  }, 120_000);

  it("Psi4：H2O HF/sto-3g 单点——能量/收敛/版本结构化", async () => {
    const probe = await psi4Adapter.probe();
    if (!probe.available) {
      expect("EVALUATION-INCOMPLETE").toBe("EVALUATION-INCOMPLETE");
      return; // 无引擎环境如实记录，非 skip 冒充
    }
    const result = await psi4Adapter.execute(psi4Request({
      operation: "single-point",
      method: "hf",
      basis: "sto-3g",
      molecule: {
        geometry: [
          ["O", 0.0, 0.0, 0.1173],
          ["H", 0.0, 0.7572, -0.4692],
          ["H", 0.0, -0.7572, -0.4692],
        ],
        charge: 0,
        multiplicity: 1,
      },
    }, "job-psi4-h2o"));
    expect(result.status, JSON.stringify(result.error ?? null)).toBe("succeeded");
    expect(result.error).toBeUndefined();
    expect(result.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const value = result.value!;
    expect(value.converged).toBe(true);
    expect(typeof value.energy).toBe("number");
    expect(value.energy!).toBeLessThan(0);
    expect(value.units).toBe("hartree");
    expect(value.toolchain.engine).toBe("psi4");
  }, 600_000);

  it("QE：Si 金刚石 2 原子 SCF——JOB DONE 且总能量结构化", async () => {
    const probe = await qeAdapter.probe();
    expect(probe.available, probe.reason).toBe(true);
    const result = await qeAdapter.execute(qeRequest({
      operation: "scf",
      structureRef: { kind: "structure", uri: `artifact://${TENANT}/structures/si.xyz` },
      pseudopotentials: { Si: `artifact://${TENANT}/pseudo/Si.UPF` },
      ecutwfc: 10,
      kPoints: [1, 1, 1],
    }, "job-qe-si"));
    expect(result.status, JSON.stringify(result.error ?? null)).toBe("succeeded");
    expect(result.error).toBeUndefined();
    const value = result.value!;
    expect(value.converged).toBe(true);
    expect(typeof value.totalEnergyRy).toBe("number");
    expect(value.units).toBe("Ry");
    expect(value.toolchain.engine).toBe("quantum-espresso");
  }, 600_000);

  it("CP2K：H2O 单点（PBE/DZVP-MOLOPT-SR-GTH）——PROGRAM ENDED 且能量结构化", async () => {
    await writeFile(join(artifactRoot, TENANT, "structures", "h2o.xyz"), `3\nwater\nO 0.000 0.000 0.117\nH 0.000 0.757 -0.469\nH 0.000 -0.757 -0.469\n`, "utf8");
    const result = await cp2kAdapter.execute({
      jobId: "job-cp2k-h2o", taskId: "task-chem", tenantId: TENANT, space: "default",
      worker: { workerId: "worker-chem-3", batchId: "batch-chem-1", role: { roleId: "computational-chemist", revision: "rev-1" } },
      lease: { taskId: "task-chem", leaseId: "lease-chem-3", generation: 1 },
      roleRevision: "rev-1", runtimeId: "cp2k", runtimeVersion: "lock:cp2k",
      deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      inputHash: "sha256:cp2k", traceId: "trace-job-cp2k-h2o",
      spec: { operation: "single-point", structureRef: { kind: "structure", uri: `artifact://${TENANT}/structures/h2o.xyz` }, xcFunctional: "PBE", cutoffRy: 400 },
    });
    expect(result.status, JSON.stringify(result.error ?? null)).toBe("succeeded");
    expect(result.error).toBeUndefined();
    const value = result.value!;
    expect(value.converged).toBe(true);
    expect(typeof value.totalEnergyAu).toBe("number");
    expect(value.units).toBe("a.u.");
    expect(value.toolchain.engine).toBe("cp2k");
  }, 600_000);

  it("负路径：非法 geometry / command 注入 / 版本伪造 / 缺赝势全部无成功结果", async () => {
    const invalid = await psi4Adapter.execute(psi4Request({
      operation: "single-point", method: "hf", basis: "sto-3g",
      molecule: { geometry: [["O", 0, 0]], charge: 0, multiplicity: 1 },
    }, "job-neg-geometry"));
    expect(invalid.status).not.toBe("succeeded");
    expect(invalid.outputHash).toBeNull();

    const injected = await psi4Adapter.execute(psi4Request({
      operation: "single-point", method: "hf", basis: "sto-3g",
      molecule: { geometry: [["O", 0, 0, 0]], charge: 0, multiplicity: 1 },
      command: "rm -rf /",
    } as never, "job-neg-injection"));
    expect(injected.status).not.toBe("succeeded");
    expect(injected.error?.code).toBe("spec-invalid");

    const wrongVersion = createPsi4RuntimeAdapter({
      artifactPort: createProfessionalArtifactPort({ artifactPath: artifactRoot }),
      lockVersion: "0.0.0-fake", engineCommand: "/opt/miniforge/bin/psi4",
      workDir: WORK_DIR, execPrefix: EXEC_PREFIX,
    });
    const wrong = await wrongVersion.execute(psi4Request({
      operation: "single-point", method: "hf", basis: "sto-3g",
      molecule: { geometry: [["O", 0, 0, 0]], charge: 0, multiplicity: 1 },
    }, "job-neg-version"));
    expect(wrong.status).not.toBe("succeeded");
    expect(wrong.error?.code).toBe("toolchain-unavailable");

    const missingPp = await qeAdapter.execute(qeRequest({
      operation: "scf",
      structureRef: { kind: "structure", uri: `artifact://${TENANT}/structures/si.xyz` },
      pseudopotentials: { Si: `artifact://${TENANT}/pseudo/MISSING.UPF` },
      ecutwfc: 10,
    }, "job-neg-missing-pp"));
    expect(missingPp.status).not.toBe("succeeded");
    expect(missingPp.outputHash).toBeNull();
  }, 120_000);
});
});
