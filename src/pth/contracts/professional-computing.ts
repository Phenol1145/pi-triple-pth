/**
 * contracts/professional-computing.ts — v1.3 Task 2 专业计算统一契约（纯类型 + 结构校验）。
 *
 * 专业 Job 永远绑定 task、lease、worker、role revision、grant、deadline、runtime version、
 * input hash 与 output artifacts；adapter 只接受本文件定义的判别 spec，绝不接受 LLM 给的
 * 任意 command/argv/shell 文本。结果信封只含数据与诊断，不含可执行回调与裸 secret。
 *
 * 本文件不 import fastify / pg / redis / @away_from/pth-sandbox 运行时实现。
 */

import { isIsoDateString } from "./identity.js";
import {
  isArtifactRefStructurallyValid,
  isTaskLeaseReferenceStructurallyValid,
  type ArtifactRef,
  type TaskLeaseReference,
} from "./tasking.js";
import type { WorkerReplicaRef } from "./cognitive-responsibility.js";

// ─── Runtime id 白名单 ──────────────────────────────────────────────────────

export const PROFESSIONAL_RUNTIME_IDS = [
  "assembly",
  "lean4",
  "wolfram",
  "psi4",
  "quantum-espresso",
  "jupyter",
] as const;
export type ProfessionalRuntimeId = (typeof PROFESSIONAL_RUNTIME_IDS)[number];

export function isProfessionalRuntimeId(v: unknown): v is ProfessionalRuntimeId {
  return typeof v === "string" && (PROFESSIONAL_RUNTIME_IDS as readonly string[]).includes(v);
}

// ─── 六种判别 job spec ─────────────────────────────────────────────────────

const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const FORBIDDEN_SPEC_KEYS = ["command", "argv", "shell", "script", "exec", "cmd", "spawn", "cmdline"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 拒绝任何 LLM 可注入的任意执行字段；spec 只允许白名单键。 */
function hasForbiddenKeys(v: Record<string, unknown>): boolean {
  return FORBIDDEN_SPEC_KEYS.some((key) => key in v);
}

function hasOnlyKeys(v: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(v);
  return keys.every((key) => allowed.includes(key));
}

// ArtifactRef 结构校验复用 contracts/tasking.ts 的既有实现，不重复导出。

// ── assembly ──

export const ASSEMBLY_OPERATIONS = ["build", "run", "disassemble", "build-run-disassemble", "verify"] as const;
export type AssemblyOperation = (typeof ASSEMBLY_OPERATIONS)[number];
export const ASSEMBLY_TARGETS = ["x86-64", "aarch64", "riscv64"] as const;
export type AssemblyTarget = (typeof ASSEMBLY_TARGETS)[number];

export interface AssemblyJobSpec {
  readonly operation: AssemblyOperation;
  readonly target: AssemblyTarget;
  readonly sourceRef: ArtifactRef;
  readonly outputArtifactName?: string;
}

export function isAssemblyJobSpecStructurallyValid(v: unknown): v is AssemblyJobSpec {
  if (!isObject(v) || hasForbiddenKeys(v)) return false;
  if (!hasOnlyKeys(v, ["operation", "target", "sourceRef", "outputArtifactName"])) return false;
  if (!NON_EMPTY_STRING(v.operation) || !(ASSEMBLY_OPERATIONS as readonly string[]).includes(v.operation)) return false;
  if (!NON_EMPTY_STRING(v.target) || !(ASSEMBLY_TARGETS as readonly string[]).includes(v.target)) return false;
  if (!isArtifactRefStructurallyValid(v.sourceRef)) return false;
  if (v.outputArtifactName !== undefined && !NON_EMPTY_STRING(v.outputArtifactName)) return false;
  return true;
}

// ── lean4 ──

export const LEAN4_OPERATIONS = ["lake-build", "check-imports", "prove"] as const;
export type Lean4Operation = (typeof LEAN4_OPERATIONS)[number];

export interface Lean4JobSpec {
  readonly operation: Lean4Operation;
  readonly projectRef: ArtifactRef;
  readonly module?: string;
  readonly declaration?: string;
}

export function isLean4JobSpecStructurallyValid(v: unknown): v is Lean4JobSpec {
  if (!isObject(v) || hasForbiddenKeys(v)) return false;
  if (!hasOnlyKeys(v, ["operation", "projectRef", "module", "declaration"])) return false;
  if (!NON_EMPTY_STRING(v.operation) || !(LEAN4_OPERATIONS as readonly string[]).includes(v.operation)) return false;
  if (!isArtifactRefStructurallyValid(v.projectRef)) return false;
  if (v.module !== undefined && !NON_EMPTY_STRING(v.module)) return false;
  if (v.declaration !== undefined && !NON_EMPTY_STRING(v.declaration)) return false;
  return true;
}

// ── wolfram ──

export const WOLFRAM_OPERATIONS = ["evaluate", "verify"] as const;
export type WolframOperation = (typeof WOLFRAM_OPERATIONS)[number];

export interface WolframJobSpec {
  readonly operation: WolframOperation;
  /** Wolfram 语言表达式，不是 shell 文本。 */
  readonly expression: string;
  readonly assumptions?: readonly string[];
  readonly maxOutputBytes?: number;
}

function isNonNegativeFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

export function isWolframJobSpecStructurallyValid(v: unknown): v is WolframJobSpec {
  if (!isObject(v) || hasForbiddenKeys(v)) return false;
  if (!hasOnlyKeys(v, ["operation", "expression", "assumptions", "maxOutputBytes"])) return false;
  if (!NON_EMPTY_STRING(v.operation) || !(WOLFRAM_OPERATIONS as readonly string[]).includes(v.operation)) return false;
  if (!NON_EMPTY_STRING(v.expression)) return false;
  if (v.assumptions !== undefined) {
    if (!Array.isArray(v.assumptions) || !v.assumptions.every((a) => NON_EMPTY_STRING(a))) return false;
  }
  if (v.maxOutputBytes !== undefined && !isNonNegativeFiniteNumber(v.maxOutputBytes)) return false;
  return true;
}

// ── psi4 ──

export const PSI4_OPERATIONS = ["single-point", "optimize"] as const;
export type Psi4Operation = (typeof PSI4_OPERATIONS)[number];

export interface Psi4Molecule {
  /** [元素符号, x, y, z]，单位由 adapter 约定为 Å。 */
  readonly geometry: readonly (readonly [string, number, number, number])[];
  readonly charge: number;
  readonly multiplicity: number;
}

export interface Psi4JobSpec {
  readonly operation: Psi4Operation;
  readonly molecule: Psi4Molecule;
  readonly method: string;
  readonly basis: string;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPsi4MoleculeStructurallyValid(v: unknown): v is Psi4Molecule {
  if (!isObject(v)) return false;
  if (!Array.isArray(v.geometry) || v.geometry.length === 0) return false;
  if (!v.geometry.every((atom) => {
    return Array.isArray(atom) && atom.length === 4 && NON_EMPTY_STRING(atom[0]) &&
      isFiniteNumber(atom[1]) && isFiniteNumber(atom[2]) && isFiniteNumber(atom[3]);
  })) return false;
  const charge = v.charge;
  const multiplicity = v.multiplicity;
  if (typeof charge !== "number" || !Number.isInteger(charge)) return false;
  if (typeof multiplicity !== "number" || !Number.isInteger(multiplicity) || multiplicity < 1) return false;
  return true;
}

export function isPsi4JobSpecStructurallyValid(v: unknown): v is Psi4JobSpec {
  if (!isObject(v) || hasForbiddenKeys(v)) return false;
  if (!hasOnlyKeys(v, ["operation", "molecule", "method", "basis"])) return false;
  if (!NON_EMPTY_STRING(v.operation) || !(PSI4_OPERATIONS as readonly string[]).includes(v.operation)) return false;
  if (!isPsi4MoleculeStructurallyValid(v.molecule)) return false;
  if (!NON_EMPTY_STRING(v.method) || !NON_EMPTY_STRING(v.basis)) return false;
  return true;
}

// ── quantum-espresso ──

export const QUANTUM_ESPRESSO_OPERATIONS = ["scf", "relax"] as const;
export type QuantumEspressoOperation = (typeof QUANTUM_ESPRESSO_OPERATIONS)[number];

export interface QuantumEspressoJobSpec {
  readonly operation: QuantumEspressoOperation;
  readonly structureRef: ArtifactRef;
  /** 元素符号 → 赝势文件引用（非宿主路径）。 */
  readonly pseudopotentials: Readonly<Record<string, string>>;
  readonly ecutwfc?: number;
  readonly kPoints?: readonly [number, number, number];
}

function isTriple(v: unknown): v is readonly [number, number, number] {
  return Array.isArray(v) && v.length === 3 && isFiniteNumber(v[0]) && isFiniteNumber(v[1]) && isFiniteNumber(v[2]);
}

export function isQuantumEspressoJobSpecStructurallyValid(v: unknown): v is QuantumEspressoJobSpec {
  if (!isObject(v) || hasForbiddenKeys(v)) return false;
  if (!hasOnlyKeys(v, ["operation", "structureRef", "pseudopotentials", "ecutwfc", "kPoints"])) return false;
  if (!NON_EMPTY_STRING(v.operation) || !(QUANTUM_ESPRESSO_OPERATIONS as readonly string[]).includes(v.operation)) return false;
  if (!isArtifactRefStructurallyValid(v.structureRef)) return false;
  if (!isObject(v.pseudopotentials) || Object.keys(v.pseudopotentials).length === 0) return false;
  if (!Object.values(v.pseudopotentials).every((p) => NON_EMPTY_STRING(p))) return false;
  if (v.ecutwfc !== undefined && !(isFiniteNumber(v.ecutwfc) && v.ecutwfc > 0)) return false;
  if (v.kPoints !== undefined && !isTriple(v.kPoints)) return false;
  return true;
}

// ── jupyter ──

export const JUPYTER_OPERATIONS = ["execute", "publish"] as const;
export type JupyterOperation = (typeof JUPYTER_OPERATIONS)[number];
export const JUPYTER_KERNELS = ["python3"] as const;
export type JupyterKernel = (typeof JUPYTER_KERNELS)[number];

export interface JupyterJobSpec {
  readonly operation: JupyterOperation;
  readonly notebookRef: ArtifactRef;
  readonly kernel: JupyterKernel;
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
}

export function isJupyterJobSpecStructurallyValid(v: unknown): v is JupyterJobSpec {
  if (!isObject(v) || hasForbiddenKeys(v)) return false;
  if (!hasOnlyKeys(v, ["operation", "notebookRef", "kernel", "parameters"])) return false;
  if (!NON_EMPTY_STRING(v.operation) || !(JUPYTER_OPERATIONS as readonly string[]).includes(v.operation)) return false;
  if (!isArtifactRefStructurallyValid(v.notebookRef)) return false;
  if (!NON_EMPTY_STRING(v.kernel) || !(JUPYTER_KERNELS as readonly string[]).includes(v.kernel)) return false;
  if (v.parameters !== undefined) {
    if (!isObject(v.parameters)) return false;
    if (!Object.values(v.parameters).every((p) =>
      typeof p === "string" || typeof p === "number" || typeof p === "boolean"
    )) return false;
  }
  return true;
}

// ── 判别联合与请求/结果信封 ────────────────────────────────────────────────

export type ProfessionalJobSpec =
  | AssemblyJobSpec
  | Lean4JobSpec
  | WolframJobSpec
  | Psi4JobSpec
  | QuantumEspressoJobSpec
  | JupyterJobSpec;

export interface ProfessionalJobRequest<S extends ProfessionalJobSpec = ProfessionalJobSpec> {
  readonly jobId: string;
  readonly taskId: string;
  readonly tenantId: string;
  readonly space: string;
  readonly worker: WorkerReplicaRef;
  readonly lease: TaskLeaseReference;
  /** 当前 role revision；必须与 worker.role.revision 一致（防止 replica 换绑）。 */
  readonly roleRevision: string;
  readonly runtimeId: ProfessionalRuntimeId;
  /** 形如 `lock:<runtimeId>`（解析到 committed lock）或与 lock 完全一致的精确版本。 */
  readonly runtimeVersion: string;
  readonly deadlineAt: string;
  readonly inputHash: string;
  /** adapter 审计链路 trace；缺省由 registry 注入 auth.traceId。 */
  readonly traceId?: string;
  readonly spec: S;
}

export type ProfessionalJobStatus = "succeeded" | "failed" | "cancelled" | "not-converged" | "unavailable";

export interface ProfessionalDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
}

export interface ProfessionalResourceUsage {
  readonly durationMs: number;
  readonly cpuMs: number;
  readonly maxRssBytes: number;
  readonly outputBytes: number;
}

export interface ProfessionalJobResult<R = unknown> {
  readonly status: ProfessionalJobStatus;
  readonly runtime: ProfessionalRuntimeId;
  readonly runtimeVersion: string;
  readonly inputHash: string;
  readonly outputHash: string | null;
  readonly artifacts: readonly ArtifactRef[];
  readonly diagnostics: readonly ProfessionalDiagnostic[];
  readonly usage: ProfessionalResourceUsage;
  readonly traceId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** adapter 专属产物数据；只能是纯数据，绝不允许函数/回调。 */
  readonly value?: R;
  readonly error?: { readonly code: string; readonly message: string };
}

// ─── 结构校验 ──────────────────────────────────────────────────────────────

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;
const FORBIDDEN_REQUEST_KEYS = ["command", "argv", "shell", "script", "exec", "cmd", "spawn", "cmdline"] as const;
const FORBIDDEN_RESULT_KEYS = ["callback", "secret", "token", "credential", "command", "argv", "shell"] as const;

function isWorkerReplicaRefStructurallyValid(v: unknown): v is WorkerReplicaRef {
  if (!isObject(v)) return false;
  if (!NON_EMPTY_STRING(v.workerId) || !NON_EMPTY_STRING(v.batchId)) return false;
  if (!isObject(v.role)) return false;
  const role = v.role as Record<string, unknown>;
  return NON_EMPTY_STRING(role.roleId) && NON_EMPTY_STRING(role.revision);
}

function isSpecStructurallyValidForRuntime(runtimeId: ProfessionalRuntimeId, spec: unknown): spec is ProfessionalJobSpec {
  switch (runtimeId) {
    case "assembly": return isAssemblyJobSpecStructurallyValid(spec);
    case "lean4": return isLean4JobSpecStructurallyValid(spec);
    case "wolfram": return isWolframJobSpecStructurallyValid(spec);
    case "psi4": return isPsi4JobSpecStructurallyValid(spec);
    case "quantum-espresso": return isQuantumEspressoJobSpecStructurallyValid(spec);
    case "jupyter": return isJupyterJobSpecStructurallyValid(spec);
  }
}

function isRuntimeVersionReference(v: unknown, runtimeId: ProfessionalRuntimeId): v is string {
  if (!NON_EMPTY_STRING(v) || v.length > 128) return false;
  if (v === `lock:${runtimeId}`) return true;
  return !/\s/.test(v);
}

export type ProfessionalJobValidationResult =
  | { ok: true; value: ProfessionalJobRequest<ProfessionalJobSpec> }
  | { ok: false; reason: string };

export function validateProfessionalJobRequest(v: unknown): ProfessionalJobValidationResult {
  if (!isObject(v)) return { ok: false, reason: "request must be an object" };
  if (FORBIDDEN_REQUEST_KEYS.some((key) => key in v)) return { ok: false, reason: "request contains an executable field" };
  if (!NON_EMPTY_STRING(v.jobId)) return { ok: false, reason: "jobId is required" };
  if (!NON_EMPTY_STRING(v.taskId)) return { ok: false, reason: "taskId is required" };
  if (!NON_EMPTY_STRING(v.tenantId)) return { ok: false, reason: "tenantId is required" };
  if (!NON_EMPTY_STRING(v.space)) return { ok: false, reason: "space is required" };
  if (!isWorkerReplicaRefStructurallyValid(v.worker)) return { ok: false, reason: "worker is invalid" };
  if (!isTaskLeaseReferenceStructurallyValid(v.lease)) return { ok: false, reason: "lease is invalid" };
  if (!NON_EMPTY_STRING(v.roleRevision)) return { ok: false, reason: "roleRevision is required" };
  const worker = v.worker as WorkerReplicaRef;
  if (v.roleRevision !== worker.role.revision) return { ok: false, reason: "roleRevision must match worker.role.revision" };
  if (!isProfessionalRuntimeId(v.runtimeId)) return { ok: false, reason: `unknown professional runtime: ${String(v.runtimeId)}` };
  if (!isRuntimeVersionReference(v.runtimeVersion, v.runtimeId)) return { ok: false, reason: "runtimeVersion must be lock:<runtimeId> or an exact version" };
  if (!isIsoDateString(v.deadlineAt)) return { ok: false, reason: "deadlineAt must be an ISO-8601 timestamp" };
  if (v.traceId !== undefined && !NON_EMPTY_STRING(v.traceId)) return { ok: false, reason: "traceId cannot be empty" };
  if (!NON_EMPTY_STRING(v.inputHash) || !SHA256_DIGEST_RE.test(v.inputHash)) {
    return { ok: false, reason: "inputHash must be sha256:<64 hex chars>" };
  }
  if (!isSpecStructurallyValidForRuntime(v.runtimeId, v.spec)) {
    return { ok: false, reason: `spec does not match ${v.runtimeId} discriminated job spec` };
  }
  return { ok: true, value: v as unknown as ProfessionalJobRequest<ProfessionalJobSpec> };
}

export function isProfessionalJobResultStructurallyValid(v: unknown): v is ProfessionalJobResult<unknown> {
  if (!isObject(v)) return false;
  if (FORBIDDEN_RESULT_KEYS.some((key) => key in v)) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.status !== "string" || !["succeeded", "failed", "cancelled", "not-converged", "unavailable"].includes(r.status)) return false;
  if (!isProfessionalRuntimeId(r.runtime)) return false;
  if (!NON_EMPTY_STRING(r.runtimeVersion)) return false;
  if (!NON_EMPTY_STRING(r.inputHash) || !SHA256_DIGEST_RE.test(r.inputHash)) return false;
  if (r.outputHash !== null && !(NON_EMPTY_STRING(r.outputHash) && SHA256_DIGEST_RE.test(r.outputHash))) return false;
  if (!Array.isArray(r.artifacts) || !r.artifacts.every(isArtifactRefStructurallyValid)) return false;
  if (!Array.isArray(r.diagnostics) || !r.diagnostics.every((d) => {
    if (!isObject(d)) return false;
    if (!NON_EMPTY_STRING(d.code)) return false;
    if (d.severity !== "info" && d.severity !== "warning" && d.severity !== "error") return false;
    return typeof d.message === "string";
  })) return false;
  if (!isObject(r.usage)) return false;
  const usage = r.usage as Record<string, unknown>;
  if (!isNonNegativeFiniteNumber(usage.durationMs) || !isNonNegativeFiniteNumber(usage.cpuMs) ||
      !isNonNegativeFiniteNumber(usage.maxRssBytes) || !isNonNegativeFiniteNumber(usage.outputBytes)) return false;
  if (!NON_EMPTY_STRING(r.traceId)) return false;
  if (!isIsoDateString(r.startedAt) || !isIsoDateString(r.finishedAt)) return false;
  if (Date.parse(r.finishedAt) < Date.parse(r.startedAt)) return false;
  if (r.value !== undefined && typeof r.value === "function") return false;
  if (r.error !== undefined) {
    if (!isObject(r.error)) return false;
    if (!NON_EMPTY_STRING(r.error.code) || typeof r.error.message !== "string") return false;
  }
  return true;
}

// ─── ProfessionalRuntimeLock（committed lock 形状，供 registry 与脚本共用） ───

export interface ProfessionalRuntimeLockEntry {
  readonly version: string;
  readonly releaseChannel: "stable";
  readonly probe: {
    readonly tool: string;
    readonly args: readonly string[];
    readonly extract: string;
  };
}

export interface ProfessionalRuntimeLock {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly runtimes: Readonly<Record<ProfessionalRuntimeId, ProfessionalRuntimeLockEntry>>;
}

export function isProfessionalRuntimeLockStructurallyValid(v: unknown): v is ProfessionalRuntimeLock {
  if (!isObject(v)) return false;
  if (v.schemaVersion !== 1) return false;
  if (!isIsoDateString(v.generatedAt)) return false;
  if (!isObject(v.runtimes)) return false;
  const runtimes = v.runtimes as Record<string, unknown>;
  for (const id of PROFESSIONAL_RUNTIME_IDS) {
    const entry = runtimes[id];
    if (!isObject(entry)) return false;
    if (!NON_EMPTY_STRING(entry.version)) return false;
    if (entry.releaseChannel !== "stable") return false;
    if (!isObject(entry.probe)) return false;
    const probe = entry.probe as Record<string, unknown>;
    if (!NON_EMPTY_STRING(probe.tool)) return false;
    if (!Array.isArray(probe.args) || !probe.args.every((a) => typeof a === "string")) return false;
    if (!NON_EMPTY_STRING(probe.extract)) return false;
  }
  return true;
}
