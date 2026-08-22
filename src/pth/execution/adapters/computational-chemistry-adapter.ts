/**
 * execution/adapters/computational-chemistry-adapter.ts — v1.3 Task 8 计算化学垂直切片。
 *
 * 两个独立 adapter：
 *  - `createPsi4RuntimeAdapter()`：Psi4 单点/几何优化；输入由服务端固定模板生成
 *    （geometry/charge/multiplicity/method/basis/memory/time/convergence）；
 *  - `createQuantumEspressoRuntimeAdapter()`：周期 SCF；结构来自 artifact，赝势
 *    是不可变 artifact 引用（不是宿主路径），运行时禁止下载替代。
 *
 * 公共纪律：引擎输入文件服务端生成，绝不接受原始命令；版本 == committed lock；
 * `not-converged` 是合法结构化结果但绝不 success；资源/收敛/版本全部结构化。
 */
import { pthConfig } from "../../config/index.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ExecutionBackend } from "@away_from/shared/execution";
import { execViaBackend, resolveExecutionBackend, unavailableAdapterExec, type AdapterExecFn } from "../exec-via-backend.js";
import {
  isPsi4JobSpecStructurallyValid,
  isQuantumEspressoJobSpecStructurallyValid,
  isCp2kJobSpecStructurallyValid,
  type ArtifactRef,
  type Psi4JobSpec,
  type ProfessionalDiagnostic,
  type ProfessionalJobRequest,
  type ProfessionalJobResult,
  type QuantumEspressoJobSpec,
  type Cp2kJobSpec,
} from "../../contracts/index.js";
import type { ProfessionalRuntimeAdapter } from "../professional-runtime.js";
import { createJobRunContext } from "./job-runner.js";
import type { ProfessionalArtifactPort } from "../../contracts/index.js";

export interface ChemExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  error?: string;
}

export type ChemExecFn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number },
) => Promise<ChemExecResult>;

interface ChemAdapterDeps {
  readonly artifactPort: ProfessionalArtifactPort;
  readonly lockVersion: string;
  readonly engineCommand: string;
  readonly versionArgs: readonly string[];
  readonly versionRegex: RegExp;
  /** 计算命令前缀（如 mpirun --oversubscribe -np 1 cp2k）；缺省 = engineCommand 本身。 */
  readonly computePrefixArgs?: readonly string[];
  /** probe 专用命令（缺省 = engineCommand）。 */
  readonly probeCommand?: string;
  readonly workDir?: string;
  readonly execPrefix?: readonly string[];
  /** execution/v1 执行面（优先于 execPrefix 的兼容解析） */
  readonly executionBackend?: ExecutionBackend;
  readonly exec?: ChemExecFn;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly clock?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface Psi4JobValue {
  readonly operation: Psi4JobSpec["operation"];
  readonly energy: number | null;
  readonly converged: boolean;
  readonly units: "hartree";
  readonly toolchain: { readonly engine: string; readonly version: string };
}

export interface QuantumEspressoJobValue {
  readonly operation: QuantumEspressoJobSpec["operation"];
  readonly totalEnergyRy: number | null;
  readonly converged: boolean;
  readonly units: "Ry";
  readonly toolchain: { readonly engine: string; readonly version: string };
}

function makeChemRunner(deps: ChemAdapterDeps): ChemExecFn {
  if (deps.exec) return deps.exec;
  const backend = resolveExecutionBackend({ executionBackend: deps.executionBackend, execPrefix: deps.execPrefix });
  const viaBackend: AdapterExecFn = backend
    ? execViaBackend(backend)
    : unavailableAdapterExec("computational-chemistry: no execution backend configured");
  const defaultTimeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (cmd, args, opts = {}) => {
    return viaBackend(cmd, args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? defaultTimeout,
      maxOutputBytes: opts.maxOutputBytes ?? deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    });
  };
}

function makeChemAdapter<S extends Psi4JobSpec | QuantumEspressoJobSpec | Cp2kJobSpec, V>(
  deps: ChemAdapterDeps,
  id: "psi4" | "quantum-espresso" | "cp2k",
  specGuard: (v: unknown) => boolean,
  inputBuilder: (spec: S, tenantId: string, port: ProfessionalArtifactPort, jobDir: string) => Promise<{ inputFile: string; inputArgs: string[]; files: Record<string, string>; outputFile?: string }>,
  resultParser: (stdout: string, spec: S, outputFileContent: string) => V,
  outputHashFor: (value: V) => string,
): ProfessionalRuntimeAdapter<S, V> {
  const clock = deps.clock ?? (() => new Date());
  const workDir = resolve(deps.workDir ?? pthConfig().str("PTH_WORKSPACES_PATH") ?? join(tmpdir(), `pth-${id}-jobs`));
  const runner = makeChemRunner(deps);
  const running = new Map<string, { cancelled: boolean }>();
  const sha256hex = (s: Uint8Array | string) => createHash("sha256").update(s).digest("hex");

  async function probe() {
    const run = await runner(deps.probeCommand ?? deps.engineCommand, [...deps.versionArgs], { timeoutMs: 60_000 });
    // 部分引擎（QE/pw.x）打印版本后因缺输入文件报错退出——只要版本可解析即视为 probe 成功。
    const m = deps.versionRegex.exec(`${run.stdout}\n${run.stderr}`);
    if (!run.ok && !m) {
      return { available: false, version: "", releaseChannel: "stable" as const, reason: `${id} 不可执行: ${run.stderr.slice(0, 300)}` };
    }
    if (!m) {
      return { available: false, version: "", releaseChannel: "stable" as const, reason: `${id} 版本不可解析: ${run.stdout.slice(0, 200)}` };
    }
    const version = m[1]!;
    if (version !== deps.lockVersion) {
      return { available: false, version, releaseChannel: "stable" as const, reason: `${id} 版本 ${version} 与 committed lock ${deps.lockVersion} 不一致` };
    }
    return { available: true, version, releaseChannel: "stable" as const };
  }

  async function execute(request: ProfessionalJobRequest<S>): Promise<ProfessionalJobResult<V>> {
    const ctx = createJobRunContext<V>({
      runtime: id,
      runtimeVersion: deps.lockVersion,
      request,
      artifactPort: deps.artifactPort,
      running,
      clock,
    });

    try {
      if (!specGuard(request.spec)) {
        return ctx.fail("spec-invalid", `spec 不是合法 ${id} job spec（含禁键或字段越界）`);
      }
      const probeResult = await probe();
      if (!probeResult.available) {
        return ctx.fail("toolchain-unavailable", probeResult.reason ?? `${id} 工具链不可用`);
      }

      const jobDir = join(workDir, `${id}-${request.jobId.replace(/[^A-Za-z0-9._-]/g, "_")}`);
      await rm(jobDir, { recursive: true, force: true });
      await mkdir(jobDir, { recursive: true });

      const built = await inputBuilder(request.spec, request.tenantId, deps.artifactPort, jobDir);
      for (const [name, content] of Object.entries(built.files)) {
        await writeFile(join(jobDir, name), content, "utf8");
      }

      const run = await runner(deps.engineCommand, [...(deps.computePrefixArgs ?? []), ...built.inputArgs], {
        cwd: jobDir,
        timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      if (run.timedOut) return ctx.fail("compute-timeout", `${id} 计算超时`);
      // 部分引擎（mpirun+CP2K）即使计算成功也可能以非零退出并打 MPI_ABORT；
      // 成功判定以输出文件内容为准（PROGRAM ENDED / JOB DONE）。
      let outputFileContent = "";
      let outputFileError = "";
      if (built.outputFile) {
        try {
          outputFileContent = await readFile(join(jobDir, built.outputFile), "utf8");
        } catch (error) {
          outputFileError = error instanceof Error ? error.message : String(error);
        }
      }
      const value = resultParser(`${run.stdout}\n${run.stderr}`, request.spec, outputFileContent);
      const converged = (value as { converged?: boolean }).converged === true;
      if (!converged) {
        if (outputFileContent === "" && !run.ok) {
          return ctx.fail("compute-failed", `${id} 执行失败 stderr=${run.stderr.slice(0, 400)} stdout_tail=${run.stdout.slice(-1200)}`);
        }
        return ctx.finish("not-converged", { code: "not-converged", message: `SCF/优化未收敛——结构化结果，不是成功（outputFile=${built.outputFile ?? "-"} err=${outputFileError || "read-ok"} exit=${run.code} out_tail=${outputFileContent.slice(-800)}）` }, value);
      }
      if (ctx.isCancelled()) return ctx.finish("cancelled", { code: "job-cancelled", message: "job cancelled after compute" });

      await deps.artifactPort.putOutput({
        tenantId: request.tenantId, jobId: request.jobId, kind: "input", mediaType: "text/plain",
        bytes: new TextEncoder().encode(built.files[built.inputFile] ?? ""),
      });
      await deps.artifactPort.putOutput({
        tenantId: request.tenantId, jobId: request.jobId, kind: "run-log", mediaType: "text/plain",
        bytes: new TextEncoder().encode(run.stdout),
      });

      return ctx.finish("succeeded", undefined, value, outputHashFor(value));
    } catch (error) {
      return ctx.fail("compute-failed", `${id} adapter 意外错误: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running.delete(request.jobId);
    }
  }

  async function cancel(jobId: string): Promise<boolean> {
    const state = running.get(jobId);
    if (!state) return false;
    state.cancelled = true;
    return true;
  }

  return { id, probe, execute, cancel };
}

// ─── Psi4 ──────────────────────────────────────────────────────────────────

const PSI4_VERSION_RE = /Psi4\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/;
const PSI4_ENERGY_RE = /Total Energy\s*=\s*(-?[0-9]+\.[0-9]+)/;
const PSI4_CONVERGED_RE = /Optimizer: Optimization complete|Psi4 stopped normally|Optimization complete/;

export function createPsi4RuntimeAdapter(deps: Omit<ChemAdapterDeps, "versionArgs" | "versionRegex"> & { engineCommand?: string }): ProfessionalRuntimeAdapter<Psi4JobSpec, Psi4JobValue> {
  return makeChemAdapter<Psi4JobSpec, Psi4JobValue>(
    { ...deps, engineCommand: deps.engineCommand ?? "psi4", versionArgs: ["--version"], versionRegex: PSI4_VERSION_RE },
    "psi4",
    isPsi4JobSpecStructurallyValid,
    async (spec) => {
      const geom = spec.molecule.geometry
        .map(([symbol, x, y, z]) => `${symbol}  ${x}  ${y}  ${z}`)
        .join("\n");
      const lines = [
        "memory 512 MB",
        `molecule {`,
        `${spec.molecule.charge} ${spec.molecule.multiplicity}`,
        geom,
        "}",
        "set basis " + spec.basis,
        "set scf_type df",
        "set reference rhf",
        "set e_convergence 1e-8",
        "set d_convergence 1e-6",
        "energy('" + spec.method + "')",
        ...(spec.operation === "optimize" ? ["optimize('" + spec.method + "')"] : []),
      ];
      return { inputFile: "input.dat", inputArgs: ["input.dat"], files: { "input.dat": lines.join("\n") + "\n" } };
    },
    (stdout, spec, outputFileContent) => {
      const combined = `${stdout}\n${outputFileContent}`;
      const energyMatch = PSI4_ENERGY_RE.exec(combined);
      return {
        operation: spec.operation,
        energy: energyMatch ? Number(energyMatch[1]) : null,
        converged: PSI4_CONVERGED_RE.test(combined),
        units: "hartree" as const,
        toolchain: { engine: "psi4", version: deps.lockVersion },
      };
    },
    (value) => `${value.energy}:${value.converged}`,
  );
}

// ─── Quantum ESPRESSO ──────────────────────────────────────────────────────

const QE_VERSION_RE = /Program PWSCF\s+v\.?\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)/;
const QE_ENERGY_RE = /!\s+total energy\s+=\s+(-?[0-9]+\.[0-9]+)\s+Ry/;
const QE_DONE_RE = /JOB DONE/;

export function createQuantumEspressoRuntimeAdapter(deps: Omit<ChemAdapterDeps, "versionArgs" | "versionRegex"> & { engineCommand?: string }): ProfessionalRuntimeAdapter<QuantumEspressoJobSpec, QuantumEspressoJobValue> {
  return makeChemAdapter<QuantumEspressoJobSpec, QuantumEspressoJobValue>(
    { ...deps, engineCommand: deps.engineCommand ?? "pw.x", versionArgs: ["--version"], versionRegex: QE_VERSION_RE },
    "quantum-espresso",
    isQuantumEspressoJobSpecStructurallyValid,
    async (spec, tenantId, port, jobDir) => {
      const structureBytes = await port.getInput(tenantId, spec.structureRef);
      const structure = new TextDecoder().decode(structureBytes).trim();
      if (structure.length === 0 || structure.length > 64 * 1024) {
        throw new Error("structure artifact 为空或超限");
      }
      // 赝势是不可变 artifact：从租户 artifact 树物化到 job pseudo 目录（不是宿主路径）。
      await mkdir(join(jobDir, "pseudo"), { recursive: true });
      for (const [el, uri] of Object.entries(spec.pseudopotentials)) {
        if (!uri.startsWith("artifact://")) {
          throw new Error(`pseudopotential ${el} 必须是 artifact:// 引用`);
        }
        const bytes = await port.getInput(tenantId, { kind: "pseudopotential", uri });
        await writeFile(join(jobDir, "pseudo", `${el}.UPF`), bytes);
      }
      const MASSES: Record<string, number> = { H: 1.00794, C: 12.0107, O: 15.9994, Si: 28.0855 };
      const ppLines = Object.entries(spec.pseudopotentials)
        .map(([el]) => `${el} ${MASSES[el] ?? 1.0} ${el}.UPF`)
        .join("\n");
      const structureLines = structure.split("\n").map((l) => l.trim()).filter((l) => l !== "");
      const cellLines = structureLines.slice(0, 3);
      const positionLines = structureLines.slice(3);
      if (cellLines.length !== 3 || positionLines.length === 0) {
        throw new Error("structure artifact 必须是 3 行晶格 + N 行原子坐标");
      }
      const lines = [
        "&CONTROL",
        "  calculation = 'scf'",
        "  prefix = 'job'",
        "  pseudo_dir = './pseudo'",
        "  verbosity = 'low'",
        "/",
        "&SYSTEM",
        `  ecutwfc = ${spec.ecutwfc ?? 30}`,
        "  ibrav = 0",
        "  nat = " + positionLines.length,
        "  ntyp = " + Object.keys(spec.pseudopotentials).length,
        "/",
        "&ELECTRONS",
        "  conv_thr = 1e-8",
        "/",
        "ATOMIC_SPECIES",
        ppLines,
        "ATOMIC_POSITIONS angstrom",
        structure,
        "K_POINTS automatic",
        [...(spec.kPoints ?? [1, 1, 1]), 0, 0, 0].join(" "),
      ];
      const cell = cellLines.join("\n");
      const positions = positionLines.join("\n");
      return {
        inputFile: "pw.in",
        inputArgs: ["-in", "pw.in"],
        files: {
          "pw.in": [
            ...lines.slice(0, lines.indexOf("ATOMIC_POSITIONS angstrom")),
            "CELL_PARAMETERS angstrom",
            cell,
            "ATOMIC_POSITIONS angstrom",
            positions,
            ...lines.slice(lines.indexOf("K_POINTS automatic")),
          ].join("\n") + "\n",
        },
      };
    },
    (stdout, spec, outputFileContent) => {
      const combined = `${stdout}\n${outputFileContent}`;
      const energyMatch = QE_ENERGY_RE.exec(combined);
      return {
        operation: spec.operation,
        totalEnergyRy: energyMatch ? Number(energyMatch[1]) : null,
        converged: QE_DONE_RE.test(combined),
        units: "Ry" as const,
        toolchain: { engine: "quantum-espresso", version: deps.lockVersion },
      };
    },
    (value) => `${value.totalEnergyRy}:${value.converged}`,
  );
}

// ─── CP2K ──────────────────────────────────────────────────────────────────

const CP2K_VERSION_RE = /CP2K version ([0-9]+\.[0-9]+)/;
const CP2K_ENERGY_RE = /ENERGY\| Total FORCE_EVAL \( QS \) energy \[a\.u\.\][:=]\s+(-?[0-9]+\.[0-9]+)/;
const CP2K_DONE_RE = /PROGRAM ENDED AT/;

export interface Cp2kJobValue {
  readonly operation: Cp2kJobSpec["operation"];
  readonly totalEnergyAu: number | null;
  readonly converged: boolean;
  readonly units: "a.u.";
  readonly toolchain: { readonly engine: string; readonly version: string };
}

export function createCp2kRuntimeAdapter(deps: Omit<ChemAdapterDeps, "versionArgs" | "versionRegex"> & { engineCommand?: string }): ProfessionalRuntimeAdapter<Cp2kJobSpec, Cp2kJobValue> {
  return makeChemAdapter<Cp2kJobSpec, Cp2kJobValue>(
    {
      ...deps,
      engineCommand: "mpirun",
      probeCommand: deps.probeCommand ?? deps.engineCommand ?? "cp2k",
      computePrefixArgs: deps.computePrefixArgs ?? ["--oversubscribe", "-np", "1", deps.engineCommand ?? "cp2k"],
      versionArgs: ["--version"], versionRegex: CP2K_VERSION_RE,
    },
    "cp2k",
    isCp2kJobSpecStructurallyValid,
    async (spec, tenantId, port) => {
      const xyzBytes = await port.getInput(tenantId, spec.structureRef);
      const xyz = new TextDecoder().decode(xyzBytes).trim();
      if (xyz.length === 0 || xyz.length > 256 * 1024) throw new Error("structure artifact 为空或超限");
      // XYZ 格式：行首是元素符号（1-2 字母 + 空白）才是原子行；跳过计数/注释头。
      const lines = xyz.split("\n").map((l) => l.trim()).filter((l) => /^[A-Za-z]{1,2}\s/.test(l));
      const kinds = [...new Set(lines.map((l) => l.split(/\s+/)[0]!))];
      const kindBlocks = kinds.map((el) => `    &KIND ${el}\n      BASIS_SET DZVP-MOLOPT-SR-GTH\n      POTENTIAL GTH-${(spec.xcFunctional ?? "PBE").toUpperCase()}\n    &END KIND`).join("\n");
      const inp = `&GLOBAL\n  PROJECT job\n  RUN_TYPE ${spec.operation === "optimize" ? "GEO_OPT" : "ENERGY"}\n  PRINT_LEVEL LOW\n&END GLOBAL\n&FORCE_EVAL\n  METHOD Quickstep\n  &DFT\n    BASIS_SET_FILE_NAME BASIS_MOLOPT\n    POTENTIAL_FILE_NAME GTH_POTENTIALS\n    &SCF\n      EPS_SCF 1.0E-7\n      MAX_SCF 100\n    &END SCF\n    &XC\n      &XC_FUNCTIONAL ${spec.xcFunctional ?? "PBE"}\n      &END XC_FUNCTIONAL\n    &END XC\n  &END DFT\n  &SUBSYS\n    &CELL\n      ABC 12.0 12.0 12.0\n      PERIODIC NONE\n    &END CELL\n    &COORD\n${lines.join("\n")}\n    &END COORD\n${kindBlocks}\n  &END SUBSYS\n&END FORCE_EVAL\n`;
      return { inputFile: "job.inp", inputArgs: ["-D", "/usr/share/cp2k/data", "-i", "job.inp", "-o", "job.out"], files: { "job.inp": inp }, outputFile: "job.out" };
    },
    (stdout, spec, outputFileContent) => {
      const energyMatch = CP2K_ENERGY_RE.exec(outputFileContent);
      return {
        operation: spec.operation,
        totalEnergyAu: energyMatch ? Number(energyMatch[1]) : null,
        converged: CP2K_DONE_RE.test(outputFileContent),
        units: "a.u." as const,
        toolchain: { engine: "cp2k", version: deps.lockVersion },
      };
    },
    (value) => `${value.totalEnergyAu}:${value.converged}`,
  );
}
