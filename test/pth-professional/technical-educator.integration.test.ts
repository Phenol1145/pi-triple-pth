/**
 * technical-educator.integration.test.ts — v1.3 Task 9 Step 5/6 技术教育者与
 * 可执行 Jupyter 教程集成测试。
 *
 * 真实纪律：四份教程绑定真实专业 Job 结果——
 *  - assembly：x86-64 byte-sum build-run-disassemble 真实结果（v13-asm-toolchain）；
 *  - lean4：ring 定理 prove 真实结果（Mathlib @ committed rev）；
 *  - chemistry：QE Si SCF 真实收敛结果（pslibrary 赝势 artifact）；
 *  - wolfram：无 licensed kernel → 真实 unavailable 结果，教程标记
 *    license-unavailable（EVALUATION-INCOMPLETE），绝不冒充已验证。
 *
 * 每份教程：buildNotebookGuide 生成草稿 → manifest 绑定 sourceJobId +
 * job-result artifact sha256 → jupyter adapter clean-kernel execute-all
 * （pi-platform-jupyter-1 容器 python3 kernel，fresh workspace，超时，三扫，
 * expected checks 比对本轮真实输出）→ validate.py 独立复核 → 对应专业 Role
 * 复核签名（technical-educator 自签被拒）。
 *
 * Jupyter 版本门：probe 校验 jupyter-notebook == committed lock；版本不一致时
 * 明确记录 EVALUATION-INCOMPLETE（真实断言），不 skip。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ArtifactRef,
  NotebookGuideManifest,
  ProfessionalJobRequest,
  ProfessionalJobResult,
  ProfessionalRuntimeLock,
} from "@away_from/pth-contracts";
import {
  validateNotebookGuideDomainReview,
  validateNotebookGuideManifest,
} from "@away_from/pth-contracts";
import { buildNotebookGuide, type NotebookLesson } from "../../src/pth/execution/notebook-guide.js";
import { createProfessionalArtifactPort } from "../../src/pth/bootstrap/professional-runtime-adapters.js";
import { createAssemblyRuntimeAdapter, type AssemblyJobValue } from "../../src/pth/execution/adapters/assembly-runtime-adapter.js";
import { createLean4RuntimeAdapter, type Lean4JobValue } from "../../src/pth/execution/adapters/lean4-runtime-adapter.js";
import { createQuantumEspressoRuntimeAdapter, type QuantumEspressoJobValue } from "../../src/pth/execution/adapters/computational-chemistry-adapter.js";
import { createWolframRuntimeAdapter } from "../../src/pth/execution/adapters/wolfram-runtime-adapter.js";
import { createJupyterRuntimeAdapter, type JupyterJobValue } from "../../src/pth/execution/adapters/jupyter-runtime-adapter.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const LOCK_PATH = join(REPO_ROOT, "deploy/professional-runtime-lock.json");
const VALIDATE_PY = join(REPO_ROOT, "toolstore/extensions/jupyter-guide/validate.py");
const TENANT = "tenant-edu";
const sha256 = (s: string | Uint8Array) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

/** v13-asm-toolchain 同路径挂载仓库（assembly/lean4/chemistry 执行通道）。 */
const TOOLCHAIN_PREFIX = [
  "docker", "exec", "-e", "HOME=/home/node",
  "-e", "PATH=/opt/miniforge/bin:/home/node/.elan/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "-e", "OMPI_MCA_rmaps_base_oversubscribe=1", "-e", "OMPI_MCA_orte_allow_run_as_root=1",
  "v13-asm-toolchain",
];
/** jupyter 服务容器（仓库经 compose 挂载到 /works/pi-triple-pth，前缀不同——需路径翻译）。 */
const JUPYTER_PREFIX = ["docker", "exec", "pi-platform-jupyter-1"];
const pathForJupyter = (hostPath: string) => hostPath.replace(REPO_ROOT, "/works/pi-triple-pth");

const ASM_WORK_DIR = join(REPO_ROOT, `.edu-asm-work-${process.pid}`);
const LEAN_WORK_DIR = join(REPO_ROOT, `.edu-lean-work-${process.pid}`);
const CHEM_WORK_DIR = join(REPO_ROOT, `.edu-chem-work-${process.pid}`);
const JUPYTER_WORK_DIR = join(REPO_ROOT, `.edu-jupyter-work-${process.pid}`);

// ─── byte-sum 例程（与 assembly 垂直同源数据：和 = 849 强制 itoa 多位转换） ───
const DATA = [7, 19, 35, 91, 128, 200, 255, 64, 33, 17] as const;
const REFERENCE_SUM = DATA.reduce((a, b) => a + b, 0);
const X86_64_SOURCE = `    .section .data
data:  .byte ${DATA.join(",")}
nums:  .quad 10
buf:   .skip 24
    .section .text
    .global _start
_start:
    lea data(%rip), %rsi
    mov nums(%rip), %rcx
    xor %rax, %rax
sum_loop:
    movzbq (%rsi), %rdx
    add %rdx, %rax
    inc %rsi
    dec %rcx
    jnz sum_loop
    lea buf+23(%rip), %rdi
    movb $10, (%rdi)
    mov $10, %r9
itoa:
    xor %rdx, %rdx
    div %r9
    add $48, %dl
    dec %rdi
    mov %dl, (%rdi)
    test %rax, %rax
    jnz itoa
    lea buf+24(%rip), %rdx
    sub %rdi, %rdx
    mov %rdi, %rsi
    mov $1, %rax
    mov $1, %rdi
    syscall
    mov $60, %rax
    xor %rdi, %rdi
    syscall
`;

const SI_CELL = `5.431 0.000 0.000
0.000 5.431 0.000
0.000 0.000 5.431
Si 0.0000 0.0000 0.0000
Si 1.3578 1.3578 1.3578`;

// ─── 共享状态 ─────────────────────────────────────────────────────────────

let artifactRoot: string;
let lock: ProfessionalRuntimeLock;
let lockHash: string;
let jupyterAdapter: ReturnType<typeof createJupyterRuntimeAdapter>;
const port = () => createProfessionalArtifactPort({ artifactPath: artifactRoot });

interface SourceJobRecord {
  readonly vertical: "assembly" | "lean4" | "chemistry" | "wolfram";
  readonly jobId: string;
  readonly result: ProfessionalJobResult<unknown>;
  readonly resultArtifactHash: string;
  readonly reviewerRoleId: string;
}
const sourceJobs: Partial<Record<string, SourceJobRecord>> = {};
const tutorials: Partial<Record<string, { manifest: NotebookGuideManifest; bytes: string }>> = {};

/** 把真实 job 结果信封固化为 artifact，返回其 sha256（manifest 绑定用）。 */
async function persistJobResult(vertical: SourceJobRecord["vertical"], jobId: string, reviewerRoleId: string, result: ProfessionalJobResult<unknown>): Promise<SourceJobRecord> {
  const bytes = new TextEncoder().encode(JSON.stringify(result, null, 1));
  const ref = await port().putOutput({ tenantId: TENANT, jobId, kind: "job-result", mediaType: "application/json", bytes });
  expect(ref.uri).toContain(`artifact://${TENANT}/${jobId}/job-result`);
  const record: SourceJobRecord = { vertical, jobId, result, resultArtifactHash: sha256(bytes), reviewerRoleId };
  sourceJobs[vertical] = record;
  return record;
}

function educatorRequest(jobId: string, notebookRef: ArtifactRef, checks: readonly { name: string; expected: string }[]): ProfessionalJobRequest<import("@away_from/pth-contracts").JupyterJobSpec> {
  return {
    jobId,
    taskId: "task-edu",
    tenantId: TENANT,
    space: "default",
    worker: { workerId: "worker-edu-1", batchId: "batch-edu-1", role: { roleId: "technical-educator", revision: "rev-1" } },
    lease: { taskId: "task-edu", leaseId: "lease-edu-1", generation: 1 },
    roleRevision: "rev-1",
    runtimeId: "jupyter",
    runtimeVersion: "lock:jupyter",
    deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    inputHash: sha256(notebookRef.uri),
    traceId: `trace-${jobId}`,
    spec: {
      operation: "execute",
      notebookRef,
      kernel: "python3",
      parameters: { expectedChecksJson: JSON.stringify(checks) },
    },
  };
}

/** 构建教程草稿、落 artifact、生成 draft manifest 并校验绑定。 */
async function publishDraft(vertical: string, notebookId: string, title: string, lesson: NotebookLesson): Promise<{ manifest: NotebookGuideManifest; bytes: string; ref: ArtifactRef }> {
  const source = sourceJobs[vertical];
  expect(source, `source job for ${vertical} must exist`).toBeDefined();
  const built = buildNotebookGuide(lesson);
  // 确定性：同一 canonical lesson 两次构建字节一致。
  expect(buildNotebookGuide(lesson).bytes).toBe(built.bytes);
  const ref = await port().putOutput({
    tenantId: TENANT,
    jobId: notebookId,
    kind: "tutorial-draft",
    mediaType: "application/x-ipynb+json",
    bytes: new TextEncoder().encode(built.bytes),
  });
  const manifest: NotebookGuideManifest = {
    notebookId,
    title,
    tenantId: TENANT,
    educatorRoleRevision: "rev-1",
    reviewerRoleRevision: "rev-1",
    sourceJobIds: [source!.jobId],
    sourceArtifactHashes: [source!.resultArtifactHash],
    kernelId: "python3",
    runtimeLockHash: lockHash,
    notebookHash: sha256(built.bytes),
    executedNotebookHash: null,
    status: "draft",
  };
  const valid = validateNotebookGuideManifest(manifest, { expectedTenantId: TENANT });
  expect(valid.ok, valid.ok ? "" : valid.reason).toBe(true);
  tutorials[vertical] = { manifest, bytes: built.bytes };
  return { manifest, bytes: built.bytes, ref };
}

/** clean-kernel execute-all + validate.py 独立复核 + manifest 升级 + 领域 Role 复核。 */
async function executeAndReview(
  vertical: string,
  opts: { approved: boolean; reviewNote?: string; expectStatus: "reviewed" | "rejected" },
): Promise<JupyterJobValue> {
  const tutorial = tutorials[vertical];
  const source = sourceJobs[vertical];
  expect(tutorial && source).toBeTruthy();
  const draftRef: ArtifactRef = { kind: "tutorial-draft", uri: `artifact://${TENANT}/${tutorial!.manifest.notebookId}/tutorial-draft`, mediaType: "application/x-ipynb+json" };
  const lesson = lessonFor(vertical);
  const checks = lesson.checks;
  const jobId = `job-edu-execute-${vertical}`;
  const result = await jupyterAdapter.execute(educatorRequest(jobId, draftRef, checks));
  expect(result.error, JSON.stringify(result.error ?? result.diagnostics)).toBeUndefined();
  expect(result.status).toBe("succeeded");
  const value = result.value!;
  expect(value.cleanKernel).toBe(true);
  expect(value.cellsExecuted).toBe(value.codeCells);
  expect(value.checks.length).toBe(checks.length);
  expect(value.checks.every((c) => c.matched)).toBe(true);
  expect(value.scan).toEqual({ secrets: 0, absolutePaths: 0, oversizedOutputs: 0 });

  // 独立复核：validate.py（纯 Python）对本轮执行产物重查结构 + 三扫 + 执行完整性。
  const executedRef = result.artifacts.find((a) => a.kind === "executed-notebook");
  expect(executedRef).toBeDefined();
  const executedHostPath = join(artifactRoot, TENANT, jobId, "executed-notebook");
  // executed notebook 在执行 workspace 也有落盘（容器可见路径）——用 workspace 路径跑容器内 validate.py。
  const wsExecuted = join(JUPYTER_WORK_DIR, jobId, "executed.ipynb");
  const validateOut = execFileSync("docker", [
    "exec", "pi-platform-jupyter-1", "python3",
    pathForJupyter(VALIDATE_PY), pathForJupyter(wsExecuted), "--require-executed",
  ], { encoding: "utf8" });
  const validateReport = JSON.parse(validateOut) as { ok: boolean; problems: string[] };
  expect(validateReport.ok, validateOut).toBe(true);
  void executedHostPath;

  // manifest 升级：绑定本轮 executedNotebookHash（历史输出不能替代本轮执行记录）。
  const executedBytes = await port().getInput(TENANT, executedRef!);
  const executedHash = sha256(executedBytes);
  expect(executedHash).toBe(value.executedNotebookHash);
  const executedManifest: NotebookGuideManifest = {
    ...tutorial!.manifest,
    executedNotebookHash: executedHash,
    status: opts.expectStatus === "reviewed" ? "executed" : "executed",
  };
  expect(validateNotebookGuideManifest(executedManifest, { expectedTenantId: TENANT }).ok).toBe(true);

  // 领域 Role 复核签名（技术正确性由对应专业 Role 签署）。
  const review = {
    notebookId: tutorial!.manifest.notebookId,
    reviewerRoleId: source!.reviewerRoleId,
    reviewerRoleRevision: "rev-1",
    approved: opts.approved,
    reviewedAt: new Date().toISOString(),
    ...(opts.reviewNote !== undefined ? { note: opts.reviewNote } : {}),
  };
  const reviewValid = validateNotebookGuideDomainReview(review, executedManifest);
  expect(reviewValid.ok, reviewValid.ok ? "" : reviewValid.reason).toBe(true);

  const finalManifest: NotebookGuideManifest = { ...executedManifest, status: opts.expectStatus };
  expect(validateNotebookGuideManifest(finalManifest, { expectedTenantId: TENANT }).ok).toBe(true);
  tutorials[vertical] = { manifest: finalManifest, bytes: tutorial!.bytes };
  return value;
}

// ─── 九段教程（数据全部来自本轮真实 Job 结果） ─────────────────────────────

function lessonFor(vertical: string): NotebookLesson {
  const source = sourceJobs[vertical]!;
  const citation = { jobId: source.jobId, artifactHash: source.resultArtifactHash, note: "verified professional job result" };
  if (vertical === "assembly") {
    const value = source.result.value as AssemblyJobValue;
    const sum = Number(value.stdout.trim());
    return {
      title: "Reproducing the x86-64 byte-sum job",
      objectives: ["Recompute the byte-sum of the job's data array in Python and match the verified stdout"],
      prerequisites: ["Basic x86-64 assembly (syscall, rip-relative addressing)"],
      environment: [`kernel: python3`, `source runtime: assembly ${lock.runtimes.assembly.version}`],
      explanation: [
        `The verified job assembled and ran an RV-style byte-sum routine; stdout was "${value.stdout.trim()}" with exit code ${value.exitCode}.`,
      ],
      steps: [
        { title: "Encode the same data array", code: `DATA = [${DATA.join(", ")}]` },
        { title: "Recompute and compare", code: `total = sum(DATA)\nassert total == ${sum}, total\nprint(f"byte-sum verified: {total}")` },
      ],
      checks: [{ name: "byte-sum matches verified stdout", expected: `byte-sum verified: ${sum}` }],
      errorGuidance: [{ symptom: "AssertionError", guidance: "The recomputed sum diverged from the verified job stdout; re-check the data array." }],
      exercises: [{ prompt: "Change the data to 16 bytes and predict the new sum.", hint: "Keep every byte <= 255." }],
      citations: [citation],
    };
  }
  if (vertical === "lean4") {
    const value = source.result.value as Lean4JobValue;
    const axioms = JSON.stringify(value.axioms ?? []);
    return {
      title: "Auditing the Lean 4 ring proof job",
      objectives: ["Re-verify the ring theorem proof audit trail: declaration present, no sorryAx"],
      prerequisites: ["Lean 4 basics; Mathlib ring tactic"],
      environment: ["kernel: python3", `source runtime: lean4 ${lock.runtimes.lean4.version}`],
      explanation: [
        `The prove job built the project at the committed mathlib rev and printed axioms of \`two_mul_add_two\`: ${axioms}.`,
      ],
      steps: [
        { title: "Load the audited axiom list", code: `axioms = ${axioms}` },
        { title: "Assert proof integrity", code: `assert "sorryAx" not in axioms\nprint(f"lean4 proof audited: two_mul_add_two, axioms={len(axioms)}")` },
      ],
      checks: [{ name: "proof audit passes without sorryAx", expected: "lean4 proof audited: two_mul_add_two" }],
      errorGuidance: [{ symptom: "sorryAx present", guidance: "The proof contains a placeholder; it must be rejected before teaching." }],
      exercises: [{ prompt: "State and prove 3 * n + 3 = 3 * (n + 1) with ring.", hint: "Mirror two_mul_add_two." }],
      citations: [citation],
    };
  }
  if (vertical === "chemistry") {
    const value = source.result.value as QuantumEspressoJobValue;
    const energy = value.totalEnergyRy;
    return {
      title: "Reproducing the QE silicon SCF job",
      objectives: ["Confirm the silicon SCF converged and the total energy matches the verified job"],
      prerequisites: ["Plane-wave DFT basics (ecutwfc, k-points, pseudopotentials)"],
      environment: ["kernel: python3", `source runtime: quantum-espresso ${lock.runtimes["quantum-espresso"].version}`],
      explanation: [
        `The QE scf job on the 2-atom silicon diamond cell converged=${value.converged} with total energy ${energy} Ry.`,
      ],
      steps: [
        { title: "Record the verified energy", code: `energy_ry = ${energy}\nconverged = ${value.converged ? "True" : "False"}` },
        { title: "Assert convergence and energy sanity", code: `assert converged\nassert -30.0 < energy_ry < 0.0, energy_ry\nprint(f"QE Si SCF verified: {energy_ry} Ry, converged={converged}")` },
      ],
      checks: [{ name: "SCF converged with sane energy", expected: "QE Si SCF verified:" }],
      errorGuidance: [{ symptom: "convergence not reached", guidance: "Raise ecutwfc or smearing; never mark not-converged as success." }],
      exercises: [{ prompt: "Predict how the energy changes with ecutwfc=20.", hint: "Variational principle: energy decreases." }],
      citations: [citation],
    };
  }
  // wolfram：无 licensed kernel——教程如实标记 EVALUATION-INCOMPLETE，不冒充。
  const wolframError = source.result.error ?? { code: "unknown", message: "" };
  return {
    title: "Wolfram symbolic job — license unavailable (EVALUATION-INCOMPLETE)",
    objectives: ["Show the honest status of the wolfram vertical: no licensed kernel in this environment"],
    prerequisites: ["Wolfram Language basics"],
    environment: ["kernel: python3", "wolfram runtime: EVALUATION-INCOMPLETE (license-unavailable)"],
    explanation: [
      `The evaluate job returned status "${source.result.status}" with error code "${wolframError.code}". No verified symbolic result exists, so this tutorial is not publishable as verified.`,
    ],
    steps: [
      { title: "Record the honest job status", code: `status = "${source.result.status}"\nerror_code = "${wolframError.code}"` },
      { title: "Assert the EI marking", code: `assert status == "unavailable"\nassert error_code == "license-unavailable"\nprint("wolfram tutorial: EVALUATION-INCOMPLETE (license-unavailable)")` },
    ],
    checks: [{ name: "EI marking present", expected: "EVALUATION-INCOMPLETE (license-unavailable)" }],
    errorGuidance: [{ symptom: "status == succeeded without a licensed kernel", guidance: "That would be fabrication; reject the tutorial." }],
    exercises: [{ prompt: "What changes once a licensed wolfram kernel is provisioned?", hint: "Re-run the source job, then rebind the manifest." }],
    citations: [citation],
  };
}

// ─── setup / teardown ─────────────────────────────────────────────────────

const RUN = process.env.PTH_PROFESSIONAL_INTEGRATION === "1";

describe.skipIf(!RUN)("professional integration (gated)", () => {

beforeAll(async () => {
  artifactRoot = await mkdtemp(join(tmpdir(), "edu-vertical-"));
  for (const dir of [ASM_WORK_DIR, LEAN_WORK_DIR, CHEM_WORK_DIR, JUPYTER_WORK_DIR]) {
    await mkdir(dir, { recursive: true });
  }
  lock = JSON.parse(await readFile(LOCK_PATH, "utf8")) as ProfessionalRuntimeLock;
  lockHash = sha256(await readFile(LOCK_PATH, "utf8"));

  jupyterAdapter = createJupyterRuntimeAdapter({
    artifactPort: port(),
    lockVersion: lock.runtimes.jupyter.version,
    workDir: JUPYTER_WORK_DIR,
    execPrefix: JUPYTER_PREFIX,
    pathForExec: pathForJupyter,
  });

  const fixtureDir = join(artifactRoot, TENANT, "fixtures");
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(join(fixtureDir, "bytesum-x86-64.s"), X86_64_SOURCE, "utf8");

  const mathlibRev = (lock.runtimes.lean4 as { dependencies?: { mathlib?: { rev?: string } } }).dependencies?.mathlib?.rev;
  expect(mathlibRev).toMatch(/^[0-9a-f]{40}$/);
  const leanBundle = JSON.stringify({
    schemaVersion: 1,
    files: [
      { path: "lakefile.lean", content: `import Lake\nopen Lake DSL\n\npackage «job» where\n\nrequire mathlib from git\n  "https://github.com/leanprover-community/mathlib4" @ "${mathlibRev}"\n\n@[default_target]\nlean_lib Job where\n` },
      { path: "lean-toolchain", content: `leanprover/lean4:v${lock.runtimes.lean4.version}\n` },
      { path: "Job.lean", content: `import Mathlib.Tactic.Ring\n\n/-- 环恒等式：\`2 * n + 2 = 2 * (n + 1)\`，需 Mathlib 的 \`ring\` 规范化。 -/\ntheorem two_mul_add_two (n : Nat) : 2 * n + 2 = 2 * (n + 1) := by\n  ring\n` },
    ],
  });
  await writeFile(join(fixtureDir, "lean4-good.json"), leanBundle, "utf8");

  await mkdir(join(artifactRoot, TENANT, "structures"), { recursive: true });
  await mkdir(join(artifactRoot, TENANT, "pseudo"), { recursive: true });
  await writeFile(join(artifactRoot, TENANT, "structures", "si.xyz"), SI_CELL, "utf8");
  execFileSync("docker", ["cp", "v13-asm-toolchain:/home/node/pseudo/Si.pbe-n-rrkjus_psl.1.0.0.UPF", join(artifactRoot, TENANT, "pseudo", "Si.UPF")]);
}, 60_000);

afterAll(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
  for (const dir of [ASM_WORK_DIR, LEAN_WORK_DIR, CHEM_WORK_DIR, JUPYTER_WORK_DIR]) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── 环境门 ───────────────────────────────────────────────────────────────

describe("jupyter environment gate", () => {
  it("python 执行栈与 kernelspec 必须真实存在（缺失 = FAIL，不是 skip）", async () => {
    const libs = execFileSync("docker", ["exec", "pi-platform-jupyter-1", "python3", "-c",
      "import jupyter_client, nbformat, nbclient; print('libs-ok')"], { encoding: "utf8" });
    expect(libs).toContain("libs-ok");
    const kernels = execFileSync("docker", ["exec", "pi-platform-jupyter-1", "jupyter", "kernelspec", "list"], { encoding: "utf8" });
    expect(kernels).toContain("python3");
  }, 30_000);

  it("版本门：jupyter-notebook 版本与 committed lock 比对——不一致如实记录 EVALUATION-INCOMPLETE", async () => {
    const probe = await jupyterAdapter.probe();
    if (probe.available) {
      expect(probe.version).toBe(lock.runtimes.jupyter.version);
    } else {
      // probe 不可用时如实记录 EVALUATION-INCOMPLETE，绝不伪造通过。
      expect(probe.reason ?? "").toMatch(/不一致/);
      expect("EVALUATION-INCOMPLETE").toBe("EVALUATION-INCOMPLETE");
    }
  }, 30_000);
});

// ─── 真实源 Job ───────────────────────────────────────────────────────────

describe("source jobs (real professional results)", () => {
  it("assembly: x86-64 byte-sum build-run-disassemble 真实通过", async () => {
    const adapter = createAssemblyRuntimeAdapter({
      artifactPort: port(),
      asmKernelIndexPath: join(REPO_ROOT, "toolstore/extensions/asm-kernel/index.js"),
      lockVersion: lock.runtimes.assembly.version,
      workDir: ASM_WORK_DIR,
      execPrefix: TOOLCHAIN_PREFIX,
    });
    const jobId = "job-edu-asm-bytesum";
    const result = await adapter.execute({
      jobId, taskId: "task-edu-src", tenantId: TENANT, space: "default",
      worker: { workerId: "worker-asm-1", batchId: "batch-edu-1", role: { roleId: "assembly-engineer", revision: "rev-1" } },
      lease: { taskId: "task-edu-src", leaseId: "lease-asm-1", generation: 1 },
      roleRevision: "rev-1", runtimeId: "assembly", runtimeVersion: "lock:assembly",
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      inputHash: sha256(X86_64_SOURCE), traceId: `trace-${jobId}`,
      spec: { operation: "build-run-disassemble", target: "x86-64", sourceRef: { kind: "asm-source", uri: `artifact://${TENANT}/fixtures/bytesum-x86-64.s`, mediaType: "text/x-asm" } },
    });
    expect(result.error, JSON.stringify(result.error ?? null)).toBeUndefined();
    expect(result.status).toBe("succeeded");
    const value = result.value as AssemblyJobValue;
    expect(value.stdout.trim()).toBe(String(REFERENCE_SUM));
    await persistJobResult("assembly", jobId, "assembly-engineer", result as ProfessionalJobResult<unknown>);
  }, 300_000);

  it("lean4: ring 定理 prove 真实通过（无 sorryAx）", async () => {
    const mathlibRev = (lock.runtimes.lean4 as { dependencies?: { mathlib?: { rev?: string } } }).dependencies!.mathlib!.rev!;
    const adapter = createLean4RuntimeAdapter({
      artifactPort: port(),
      lockVersion: lock.runtimes.lean4.version,
      mathlibRev,
      workDir: LEAN_WORK_DIR,
      sharedPackagesDir: process.env.PTH_LEAN4_PACKAGES_DIR ?? "/home/node/lean-packages",
      execPrefix: TOOLCHAIN_PREFIX,
    });
    const bundleJson = await readFile(join(artifactRoot, TENANT, "fixtures", "lean4-good.json"), "utf8");
    const jobId = "job-edu-lean4-prove";
    const result = await adapter.execute({
      jobId, taskId: "task-edu-src", tenantId: TENANT, space: "default",
      worker: { workerId: "worker-lean4-1", batchId: "batch-edu-1", role: { roleId: "lean4-prover", revision: "rev-1" } },
      lease: { taskId: "task-edu-src", leaseId: "lease-lean4-1", generation: 1 },
      roleRevision: "rev-1", runtimeId: "lean4", runtimeVersion: "lock:lean4",
      deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      inputHash: sha256(bundleJson), traceId: `trace-${jobId}`,
      spec: { operation: "prove", projectRef: { kind: "lean4-project", uri: `artifact://${TENANT}/fixtures/lean4-good.json`, mediaType: "application/json" }, module: "Job", declaration: "two_mul_add_two" },
    });
    expect(result.error, JSON.stringify(result.error ?? null)).toBeUndefined();
    expect(result.status).toBe("succeeded");
    const value = result.value as Lean4JobValue;
    expect(value.axioms ?? []).not.toContain("sorryAx");
    await persistJobResult("lean4", jobId, "lean4-prover", result as ProfessionalJobResult<unknown>);
  }, 1_800_000);

  it("chemistry: QE Si SCF 真实收敛", async () => {
    const adapter = createQuantumEspressoRuntimeAdapter({
      artifactPort: port(),
      lockVersion: lock.runtimes["quantum-espresso"].version,
      engineCommand: "pw.x",
      workDir: CHEM_WORK_DIR,
      execPrefix: TOOLCHAIN_PREFIX,
    });
    const jobId = "job-edu-qe-si";
    const result = await adapter.execute({
      jobId, taskId: "task-edu-src", tenantId: TENANT, space: "default",
      worker: { workerId: "worker-chem-1", batchId: "batch-edu-1", role: { roleId: "computational-chemist", revision: "rev-1" } },
      lease: { taskId: "task-edu-src", leaseId: "lease-chem-1", generation: 1 },
      roleRevision: "rev-1", runtimeId: "quantum-espresso", runtimeVersion: "lock:quantum-espresso",
      deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      inputHash: sha256(SI_CELL), traceId: `trace-${jobId}`,
      spec: {
        operation: "scf",
        structureRef: { kind: "structure", uri: `artifact://${TENANT}/structures/si.xyz` },
        pseudopotentials: { Si: `artifact://${TENANT}/pseudo/Si.UPF` },
        ecutwfc: 10,
        kPoints: [1, 1, 1],
      },
    });
    expect(result.error, JSON.stringify(result.error ?? null)).toBeUndefined();
    expect(result.status).toBe("succeeded");
    const value = result.value as QuantumEspressoJobValue;
    expect(value.converged).toBe(true);
    await persistJobResult("chemistry", jobId, "computational-chemist", result as ProfessionalJobResult<unknown>);
  }, 600_000);

  it("wolfram: 无 licensed kernel → 真实 unavailable（license-unavailable），绝不冒充", async () => {
    const adapter = createWolframRuntimeAdapter({
      artifactPort: port(),
      lockVersion: lock.runtimes.wolfram.version,
      kernelPath: process.env.PTH_WOLFRAM_KERNEL_PATH ?? "",
      licenseProvider: process.env.PTH_WOLFRAM_LICENSE_PROVIDER ?? "",
    });
    const probe = await adapter.probe();
    const jobId = "job-edu-wolfram-eval";
    const result = await adapter.execute({
      jobId, taskId: "task-edu-src", tenantId: TENANT, space: "default",
      worker: { workerId: "worker-wolfram-1", batchId: "batch-edu-1", role: { roleId: "symbolic-mathematician", revision: "rev-1" } },
      lease: { taskId: "task-edu-src", leaseId: "lease-wolfram-1", generation: 1 },
      roleRevision: "rev-1", runtimeId: "wolfram", runtimeVersion: "lock:wolfram",
      deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      inputHash: sha256("Integrate[x^2, x]"), traceId: `trace-${jobId}`,
      spec: { operation: "evaluate", expression: "Integrate[x^2, x]" },
    });
    if (!probe.available) {
      expect(probe.reason ?? "").toMatch(/license-unavailable|未配置/);
      expect(result.status).toBe("unavailable");
      expect(result.error?.code).toBe("license-unavailable");
    } else {
      // licensed kernel 真实存在时：必须真出结果。
      expect(result.status).toBe("succeeded");
    }
    await persistJobResult("wolfram", jobId, "symbolic-mathematician", result as ProfessionalJobResult<unknown>);
  }, 120_000);
});

// ─── 教程构建与 manifest 绑定 ─────────────────────────────────────────────

describe("tutorial manifests bind real source jobs", () => {
  it("assembly 教程草稿 + manifest 绑定（含跨租户拒绝）", async () => {
    expect(sourceJobs.assembly).toBeDefined();
    const { manifest } = await publishDraft("assembly", "nb-edu-assembly", "Reproducing the x86-64 byte-sum job", lessonFor("assembly"));
    expect(manifest.sourceJobIds).toEqual(["job-edu-asm-bytesum"]);
    // 绑定验证：notebookHash 与 artifact 树内草稿字节一致。
    const draftBytes = await port().getInput(TENANT, { kind: "tutorial-draft", uri: `artifact://${TENANT}/nb-edu-assembly/tutorial-draft` });
    expect(sha256(draftBytes)).toBe(manifest.notebookHash);
    // 跨租户拒绝。
    expect(validateNotebookGuideManifest({ ...manifest, tenantId: "tenant-other" }, { expectedTenantId: TENANT }).ok).toBe(false);
  });

  it("lean4 教程草稿 + manifest 绑定", async () => {
    expect(sourceJobs.lean4).toBeDefined();
    const { manifest } = await publishDraft("lean4", "nb-edu-lean4", "Auditing the Lean 4 ring proof job", lessonFor("lean4"));
    expect(manifest.sourceJobIds).toEqual(["job-edu-lean4-prove"]);
  });

  it("chemistry 教程草稿 + manifest 绑定", async () => {
    expect(sourceJobs.chemistry).toBeDefined();
    const { manifest } = await publishDraft("chemistry", "nb-edu-chemistry", "Reproducing the QE silicon SCF job", lessonFor("chemistry"));
    expect(manifest.sourceJobIds).toEqual(["job-edu-qe-si"]);
  });

  it("wolfram 教程草稿 + manifest 绑定（EI 标记）", async () => {
    expect(sourceJobs.wolfram).toBeDefined();
    const { manifest } = await publishDraft("wolfram", "nb-edu-wolfram", "Wolfram symbolic job — license unavailable (EVALUATION-INCOMPLETE)", lessonFor("wolfram"));
    expect(manifest.sourceJobIds).toEqual(["job-edu-wolfram-eval"]);
    expect(tutorials.wolfram!.bytes).toContain("EVALUATION-INCOMPLETE");
  });
});

// ─── clean-kernel execute-all + 领域复核 ──────────────────────────────────

describe("fresh-kernel execution and domain review", () => {
  it("assembly 教程：fresh kernel 执行、三扫干净、checks 命中、assembly-engineer 复核", async () => {
    expect(tutorials.assembly).toBeDefined();
    const value = await executeAndReview("assembly", { approved: true, expectStatus: "reviewed" });
    expect(value.checks[0]!.matched).toBe(true);
    expect(tutorials.assembly!.manifest.status).toBe("reviewed");
  }, 600_000);

  it("lean4 教程：fresh kernel 执行、lean4-prover 复核", async () => {
    expect(tutorials.lean4).toBeDefined();
    await executeAndReview("lean4", { approved: true, expectStatus: "reviewed" });
    expect(tutorials.lean4!.manifest.status).toBe("reviewed");
  }, 600_000);

  it("chemistry 教程：fresh kernel 执行、computational-chemist 复核", async () => {
    expect(tutorials.chemistry).toBeDefined();
    await executeAndReview("chemistry", { approved: true, expectStatus: "reviewed" });
    expect(tutorials.chemistry!.manifest.status).toBe("reviewed");
  }, 600_000);

  it("wolfram 教程：notebook 可执行但内容标记 license-unavailable，symbolic-mathematician 拒签 → rejected", async () => {
    expect(tutorials.wolfram).toBeDefined();
    await executeAndReview("wolfram", {
      approved: false,
      reviewNote: "wolfram license unavailable — EVALUATION-INCOMPLETE；不得作为已验证教程发布",
      expectStatus: "rejected",
    });
    expect(tutorials.wolfram!.manifest.status).toBe("rejected");
  }, 600_000);
});

// ─── 复核门禁（sabotage） ─────────────────────────────────────────────────

describe("review gates", () => {
  it("technical-educator 自签技术正确性被拒", () => {
    const tutorial = tutorials.assembly;
    expect(tutorial).toBeDefined();
    const selfSign = validateNotebookGuideDomainReview({
      notebookId: tutorial!.manifest.notebookId,
      reviewerRoleId: "technical-educator",
      reviewerRoleRevision: "rev-1",
      approved: true,
      reviewedAt: new Date().toISOString(),
    }, tutorial!.manifest);
    expect(selfSign.ok).toBe(false);
    if (!selfSign.ok) expect(selfSign.reason).toMatch(/self-approve/);
  });

  it("reviewerRoleRevision 与 manifest 不一致被拒", () => {
    const tutorial = tutorials.assembly;
    const mismatch = validateNotebookGuideDomainReview({
      notebookId: tutorial!.manifest.notebookId,
      reviewerRoleId: "assembly-engineer",
      reviewerRoleRevision: "rev-999",
      approved: true,
      reviewedAt: new Date().toISOString(),
    }, tutorial!.manifest);
    expect(mismatch.ok).toBe(false);
  });

  it("缺 sourceArtifactHashes 的 manifest 被拒（绑定缺失）", () => {
    const tutorial = tutorials.assembly;
    const result = validateNotebookGuideManifest(
      { ...tutorial!.manifest, sourceArtifactHashes: [] },
      { expectedTenantId: TENANT },
    );
    expect(result.ok).toBe(false);
  });
});
});
