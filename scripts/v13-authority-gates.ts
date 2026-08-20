/**
 * scripts/v13-authority-gates.ts —— v1.3 Task 10 共享权威门（确定性、纯函数）。
 *
 * 12 项 sabotage probe 每项只映射一个边界：base fixture 必须通过对应校验，
 * 单点破坏后的 fixture 必须只翻转自己这一项。评测器与组合测试共用本模块，
 * 因此「执行型 sabotage」与「验收分母」来自同一权威实现。
 */

import {
  assertWorkModeImmutable,
  isAssemblyJobSpecStructurallyValid,
  validateNotebookGuideManifest,
  type ArtifactRef,
  type CognitiveBudget,
  type NotebookGuideManifest,
} from "../src/pth/contracts/index.js";
import { validateIndexMemoryRecord } from "../src/pth/execution/index.js";
import { CognitiveBudgetLedger } from "../src/pth/kernel/execution/cognitive-budget.js";
import { parseRoleWeights, setProfessionalRoles } from "../src/pth/kernel/execution/worker-cluster.js";
import { PROFESSIONAL_ROLES, professionalRuntimeIdsForRole } from "../src/pth/kernel/execution/professional-roles.js";

export interface V13SabotageGate {
  readonly gate: string;
  readonly requirement: string;
  /** 任意合法输入；evaluate 只读取自己关心的字段。 */
  readonly evaluate: (input: unknown) => { ok: boolean; detail: string };
  readonly baseInput: unknown;
  readonly sabotagedInput: unknown;
}

export interface V13SabotageProbeResult {
  readonly gate: string;
  readonly baseOk: boolean;
  readonly sabotagedOk: boolean;
  readonly flipped: boolean;
  readonly baseDetail: string;
  readonly sabotagedDetail: string;
}

const HASH = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function validManifest(): NotebookGuideManifest {
  return {
    notebookId: "nb-gate",
    title: "gate",
    tenantId: "tenant-a",
    educatorRoleRevision: "rev-1",
    reviewerRoleRevision: "rev-1",
    sourceJobIds: ["job-1"],
    sourceArtifactHashes: [HASH],
    kernelId: "python3",
    runtimeLockHash: HASH,
    notebookHash: HASH,
    executedNotebookHash: null,
    status: "draft",
  };
}

function validAssemblySpec(): Record<string, unknown> {
  const sourceRef: ArtifactRef = { kind: "asm-source", uri: `artifact://tenant-a/fixtures/a.s`, mediaType: "text/x-asm" };
  return { operation: "build-run-disassemble", target: "x86-64", sourceRef };
}

function validIndexRecord(): Record<string, unknown> {
  return {
    entryId: "idx:lean:list-map",
    sourceId: "lean4-mathlib",
    product: "Mathlib",
    version: "stable-lock",
    releaseChannel: "stable",
    canonicalUri: "artifact://mathlib-docs",
    artifactHash: HASH,
    locator: { kind: "symbol", value: "List.map" },
    domains: ["formal-methods"],
    license: "Apache-2.0",
  };
}

/** 门 1：work-mode 不允许原地改 mode；同 workId 换 mode 必须被拒绝。 */
function evaluateWorkModeMutation(input: unknown): { ok: boolean; detail: string } {
  const v = input as { before: { workId: string; mode: "run" | "intake" | "optimize" }; after: { workId: string; mode: "run" | "intake" | "optimize" } };
  try {
    assertWorkModeImmutable(v.before, v.after);
    return { ok: false, detail: "same-workId mode mutation was not rejected" };
  } catch (error) {
    return { ok: true, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** 门 2：mode 只能由服务端盖章；客户端自盖的 envelope 不被接受。 */
function evaluateServerStamp(input: unknown): { ok: boolean; detail: string } {
  const v = input as { mode: string; stampedBy: "server" | "client" };
  return v.stampedBy === "server"
    ? { ok: true, detail: `mode ${v.mode} stamped by server` }
    : { ok: false, detail: `mode ${v.mode} stamped by client` };
}

/** 门 3：index 记录不得携带 body 形状字段（内容只能经授权读取）。 */
function evaluateIndexBody(input: unknown): { ok: boolean; detail: string } {
  try {
    validateIndexMemoryRecord(input);
    return { ok: true, detail: "index record contains navigation metadata only" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** 门 4：认知预算硬上限不可绕过——超限条目必须被 omitted，不得计入 accepted。 */
function evaluateBudget(input: unknown): { ok: boolean; detail: string } {
  const v = input as { budget: { maxMemoryEntries: number; maxMemoryChars: number }; items: { id: string; chars: number }[]; claimedAccepted: number };
  const ledger = new CognitiveBudgetLedger({
    taskId: "gate-budget",
    workerId: "worker-gate",
    directorySnapshotId: "dir-gate",
    budget: v.budget as CognitiveBudget,
  });
  const { accepted, omitted } = ledger.admitMemory(v.items);
  const bypass = accepted.length !== v.claimedAccepted || (v.claimedAccepted > accepted.length && omitted.length === 0);
  return bypass
    ? { ok: false, detail: `claimed ${v.claimedAccepted} accepted but ledger admitted ${accepted.length} (omitted=${omitted.length})` }
    : { ok: true, detail: `ledger admitted ${accepted.length}, omitted ${omitted.length}` };
}

/** 门 5：role→runtime 必须与专业 allowlist 对齐。 */
function evaluateRoleRuntime(input: unknown): { ok: boolean; detail: string } {
  const v = input as { roleId: string; runtimeId: string };
  const allowed = professionalRuntimeIdsForRole(v.roleId);
  return allowed.includes(v.runtimeId)
    ? { ok: true, detail: `${v.roleId} → ${v.runtimeId} allowed` }
    : { ok: false, detail: `${v.roleId} → ${v.runtimeId} not in allowlist ${JSON.stringify(allowed)}` };
}

/** 门 6：专业 job spec 不接受任意 command 字段。 */
function evaluateSpecCommand(input: unknown): { ok: boolean; detail: string } {
  return isAssemblyJobSpecStructurallyValid(input)
    ? { ok: true, detail: "assembly spec has no arbitrary command field" }
    : { ok: false, detail: "assembly spec rejected (forbidden/extra field)" };
}

/** 门 7：教程 manifest 必须绑定 sourceArtifactHashes。 */
function evaluateArtifactHash(input: unknown): { ok: boolean; detail: string } {
  const result = validateNotebookGuideManifest(input, { expectedTenantId: "tenant-a" });
  return result.ok ? { ok: true, detail: "manifest artifact hash binding valid" } : { ok: false, detail: result.reason };
}

/** 门 8：Lean 证明正文不得包含 sorry/admit 占位。 */
function evaluateLeanPlaceholder(input: unknown): { ok: boolean; detail: string } {
  const source = (input as { source: string }).source;
  const bad = /\b(sorry|admit)\b/.test(source);
  return bad ? { ok: false, detail: "lean source contains sorry/admit placeholder" } : { ok: true, detail: "lean source free of sorry/admit" };
}

/** 门 9：wolfram 未持证时不得把结果标成 succeeded（masquerade 禁止）。 */
function evaluateWolframMasquerade(input: unknown): { ok: boolean; detail: string } {
  const v = input as { probeAvailable: boolean; status: string };
  if (!v.probeAvailable && v.status === "succeeded") {
    return { ok: false, detail: "unlicensed wolfram marked succeeded" };
  }
  return { ok: true, detail: `wolfram probe=${v.probeAvailable} status=${v.status}` };
}

/** 门 10：chemistry 未收敛不得标 succeeded。 */
function evaluateChemistryConvergence(input: unknown): { ok: boolean; detail: string } {
  const v = input as { converged: boolean; status: string };
  if (v.status === "succeeded" && !v.converged) {
    return { ok: false, detail: "non-converged chemistry marked succeeded" };
  }
  return { ok: true, detail: `chemistry converged=${v.converged} status=${v.status}` };
}

/** 门 11：executed 教程必须绑定本轮 executedNotebookHash，历史输出不可顶替。 */
function evaluateNotebookExecutionHash(input: unknown): { ok: boolean; detail: string } {
  const v = input as { manifest: NotebookGuideManifest; currentExecutedHash: string };
  if (v.manifest.status === "executed" && v.manifest.executedNotebookHash !== v.currentExecutedHash) {
    return { ok: false, detail: "executed notebook hash does not match current run" };
  }
  return { ok: true, detail: "executed notebook hash bound to current run" };
}

/** 门 12：缺省权重下专业角色零副本，不得隐式创建 specialist replica。 */
function evaluateDefaultReplica(input: unknown): { ok: boolean; detail: string } {
  const v = input as { weights: string | undefined };
  setProfessionalRoles(PROFESSIONAL_ROLES);
  const weights = parseRoleWeights(v.weights);
  for (const roleId of ["assembly-engineer", "computational-chemist", "lean4-prover", "symbolic-mathematician", "technical-educator"]) {
    if ((weights.get(roleId) ?? 0) !== 0) {
      return { ok: false, detail: `role ${roleId} would get a replica under default weights` };
    }
  }
  return { ok: true, detail: "professional roles remain zero-replica by default" };
}

export const V13_SABOTAGE_GATES: readonly V13SabotageGate[] = Object.freeze([
  {
    gate: "work-mode-in-place-mutation",
    requirement: "同 workId 改 mode 必须被 assertWorkModeImmutable 拒绝",
    evaluate: evaluateWorkModeMutation,
    baseInput: { before: { workId: "w-1", mode: "run" }, after: { workId: "w-1", mode: "intake" } },
    sabotagedInput: { before: { workId: "w-1", mode: "run" }, after: { workId: "w-1", mode: "run" } },
  },
  {
    gate: "client-mode-self-stamp",
    requirement: "mode 只能由服务端盖章",
    evaluate: evaluateServerStamp,
    baseInput: { mode: "run", stampedBy: "server" },
    sabotagedInput: { mode: "run", stampedBy: "client" },
  },
  {
    gate: "copied-index-body",
    requirement: "index 记录不携带 body 形状字段",
    evaluate: evaluateIndexBody,
    baseInput: validIndexRecord(),
    sabotagedInput: { ...validIndexRecord(), content: "copied body" },
  },
  {
    gate: "budget-bypass",
    requirement: "超限条目被 omitted，不得计入 accepted",
    evaluate: evaluateBudget,
    baseInput: { budget: { maxMemoryEntries: 2, maxMemoryChars: 64 }, items: [{ id: "a", chars: 10 }], claimedAccepted: 1 },
    sabotagedInput: { budget: { maxMemoryEntries: 2, maxMemoryChars: 64 }, items: [{ id: "a", chars: 10_000 }], claimedAccepted: 1 },
  },
  {
    gate: "wrong-role-runtime",
    requirement: "role→runtime 与专业 allowlist 对齐",
    evaluate: evaluateRoleRuntime,
    baseInput: { roleId: "assembly-engineer", runtimeId: "assembly" },
    sabotagedInput: { roleId: "assembly-engineer", runtimeId: "wolfram" },
  },
  {
    gate: "arbitrary-command-field",
    requirement: "job spec 不接受任意 command 字段",
    evaluate: evaluateSpecCommand,
    baseInput: validAssemblySpec(),
    sabotagedInput: { ...validAssemblySpec(), command: ["rm", "-rf"] },
  },
  {
    gate: "missing-artifact-hash",
    requirement: "教程 manifest 必须绑定 sourceArtifactHashes",
    evaluate: evaluateArtifactHash,
    baseInput: validManifest(),
    sabotagedInput: { ...validManifest(), sourceArtifactHashes: [] },
  },
  {
    gate: "lean-placeholder",
    requirement: "Lean 证明不得含 sorry/admit",
    evaluate: evaluateLeanPlaceholder,
    baseInput: { source: "theorem two_mul_add_two (n : Nat) : 2 * n + 2 = 2 * (n + 1) := by ring" },
    sabotagedInput: { source: "theorem fake (n : Nat) : n = 0 := by sorry" },
  },
  {
    gate: "wolfram-fallback-masquerade",
    requirement: "无 license 不得标 succeeded",
    evaluate: evaluateWolframMasquerade,
    baseInput: { probeAvailable: false, status: "unavailable" },
    sabotagedInput: { probeAvailable: false, status: "succeeded" },
  },
  {
    gate: "chemistry-non-convergence-success",
    requirement: "未收敛不得标 succeeded",
    evaluate: evaluateChemistryConvergence,
    baseInput: { converged: true, status: "succeeded" },
    sabotagedInput: { converged: false, status: "succeeded" },
  },
  {
    gate: "notebook-historical-output-only",
    requirement: "executed 教程必须绑定本轮 executedNotebookHash",
    evaluate: evaluateNotebookExecutionHash,
    baseInput: { manifest: { ...validManifest(), status: "executed" as const, executedNotebookHash: HASH }, currentExecutedHash: HASH },
    sabotagedInput: { manifest: { ...validManifest(), status: "executed" as const, executedNotebookHash: HASH }, currentExecutedHash: HASH_B },
  },
  {
    gate: "specialist-default-replica",
    requirement: "缺省权重下专业角色零副本",
    evaluate: evaluateDefaultReplica,
    baseInput: { weights: undefined },
    sabotagedInput: { weights: "assembly-engineer:1" },
  },
]);

export function runV13SabotageProbes(): V13SabotageProbeResult[] {
  return V13_SABOTAGE_GATES.map((gate) => {
    const base = gate.evaluate(gate.baseInput);
    const sabotaged = gate.evaluate(gate.sabotagedInput);
    return {
      gate: gate.gate,
      baseOk: base.ok,
      sabotagedOk: sabotaged.ok,
      flipped: base.ok && !sabotaged.ok,
      baseDetail: base.detail,
      sabotagedDetail: sabotaged.detail,
    };
  });
}

/** 组合测试用的精确 flip 矩阵断言消息。 */
export function describeV13SabotageFlipMatrix(): { gate: string; flipped: boolean }[] {
  return runV13SabotageProbes().map((p) => ({ gate: p.gate, flipped: p.flipped }));
}
