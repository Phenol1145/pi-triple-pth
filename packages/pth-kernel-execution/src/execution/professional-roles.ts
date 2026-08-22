/**
 * kernel/execution/professional-roles.ts —— v1.3 Task 3 五个显式专业角色。
 *
 * 谱系冻结自 docs/pth/n32-v13-professional-computing-design.md §4「Role 谱系」：
 *   - assembly-engineer     parent=developer gen=4 → assembly
 *   - computational-chemist parent=solver    gen=5 → psi4 + quantum-espresso
 *   - lean4-prover          parent=solver    gen=5 → lean4
 *   - symbolic-mathematician parent=solver   gen=5 → wolfram
 *   - technical-educator    parent=writer    gen=4 → jupyter
 *
 * 专业角色是 explicit-only 谱系叶子：默认 batch 零副本，只有 Profile 或
 * `PTH_WORKER_ROLES` 显式指定时才产生 Worker Replica。因此本文件只提供角色定义、
 * role→runtime 查询与共享记忆责任/预算 fixture；不进入 allWorkerRoles() 隐式单副本循环。
 */

import {
  N28_FEASIBILITY_BUDGET,
  PROFESSIONAL_RUNTIME_ROLE_ALLOWLIST,
  type CognitiveBudget,
  type MemoryRegion,
  type MemoryResponsibility,
  type ProfessionalRuntimeId,
  type WorkerReplicaRef,
} from "@away_from/pth-contracts";
import { roleDefinitionRevision } from "./worker-replica.js";
import type { RoleDefinition } from "./worker-cluster.js";

/** 冻结一个角色定义（数组字段一并冻结，防运行时误改）。 */
function freezeRole(def: RoleDefinition): RoleDefinition {
  return Object.freeze({
    ...def,
    tags: Object.freeze([...(def.tags ?? [])]),
    capabilities: Object.freeze([...(def.capabilities ?? [])]),
    actionTools: Object.freeze([...(def.actionTools ?? [])]),
    defaultReads: Object.freeze([...(def.defaultReads ?? [])]),
  }) as unknown as RoleDefinition;
}

/**
 * 五个显式专业角色（窄 capability：无通用 ext、无 unrestricted bash、无全量 adapter）。
 * role→runtime 与 execution/professional-runtime.ts 的 allowlist 对齐：
 * 本文件只经 `professionalRuntimeIdsForRole()` 派生，不复制第二份映射。
 */
export const PROFESSIONAL_ROLES: RoleDefinition[] = Object.freeze([
  freezeRole({
    id: "assembly-engineer",
    tags: ["assembly-engineer", "binary-analysis", "disassembly", "object-code"],
    prompt: "你是汇编工程师——负责把规格编译/汇编为可运行二进制，执行反汇编、链接与测试/性能证据采集，产出可运行二进制、反汇编、测试与性能证据。专业计算一律经 assembly 适配器提交（判别联合 spec，禁止任意 shell/argv）；用 ts 程序面组合 memory/fs/readSource 完成证据整理与产物归档。",
    description: "汇编工程师（developer 子类型——可运行二进制/反汇编/测试与性能证据；assembly 适配器）",
    thinking: "high",
    capabilities: ["memory", "readSource", "readText", "fs", "skills", "c"],
    memoryScope: "own",
    actionTools: ["execTs", "nav", "cache"],
    output: "binary-artifact",
    defaultReads: ["context", "plan"],
    acceptanceRole: "writer",
    parent: "developer",
    generation: 4,
    differentiation: "专业计算任务诱导——可运行二进制/反汇编/性能证据需要 assembly 运行时与工具链证据，从 developer 分出汇编工程专精",
    loadPolicyRef: "professional:assembly-engineer:v1",
  }),
  freezeRole({
    id: "computational-chemist",
    tags: ["computational-chemist", "quantum-chemistry", "molecular-modeling"],
    prompt: "你是计算化学家——负责分子单点能/结构优化与小周期体系 SCF 计算，记录几何、charge/multiplicity、方法、basis/pseudopotential、收敛阈值与软件版本，产出输入文件、收敛轨迹、结构/能量结果。计算必须经 psi4 / quantum-espresso 适配器提交；超预算作业在启动前拒绝，不收敛返回结构化 not-converged。",
    description: "计算化学家（solver 子类型——输入文件/收敛轨迹/结构能量结果；psi4+quantum-espresso 适配器）",
    thinking: "high",
    capabilities: ["memory", "readSource", "readText", "fs", "skills"],
    memoryScope: "own",
    actionTools: ["execTs", "nav", "cache"],
    output: "chemistry-result",
    defaultReads: ["context", "conclusion"],
    acceptanceRole: "writer",
    parent: "solver",
    generation: 5,
    differentiation: "专业计算任务诱导——量子化学单点能/优化与周期 SCF 需要 psi4/QE 双运行时，从 solver 分出计算化学专精",
    loadPolicyRef: "professional:computational-chemist:v1",
  }),
  freezeRole({
    id: "lean4-prover",
    tags: ["lean4-prover", "lean4", "formal-proof"],
    prompt: "你是 Lean 4 证明工程师——负责形式化定理证明：使用固定 Lean 4/Lake/Mathlib 稳定版本，干净工程编译成功，源码中 sorry/admit/未关闭目标为零；保存 theorem、依赖锁、diagnostics 与构建 hash。证明计算必须经 lean4 适配器提交。",
    description: "Lean 4 证明工程师（solver 子类型——无占位证明/编译诊断/依赖锁；lean4 适配器）",
    thinking: "high",
    capabilities: ["memory", "readSource", "readText", "fs", "skills"],
    memoryScope: "own",
    actionTools: ["execTs", "nav", "cache"],
    output: "lean4-proof",
    defaultReads: ["context", "conclusion"],
    acceptanceRole: "writer",
    parent: "solver",
    generation: 5,
    differentiation: "专业计算任务诱导——无 sorry 形式化证明需要固定 Lean 4/Lake/Mathlib 工具链，从 solver 分出形式化证明专精",
    loadPolicyRef: "professional:lean4-prover:v1",
  }),
  freezeRole({
    id: "symbolic-mathematician",
    tags: ["symbolic-mathematician", "wolfram", "symbolic-computation"],
    prompt: "你是符号数学家——负责符号代数推导、假设管理、消息解释与数值交叉验证，产出表达式、假设、消息、数值复核。计算必须经 wolfram 适配器提交；许可证不可用时明确 unavailable，绝不静默改用其他引擎冒充同一结果。",
    description: "符号数学家（solver 子类型——表达式/假设/消息/数值复核；wolfram 适配器）",
    thinking: "high",
    capabilities: ["memory", "readSource", "readText", "fs", "skills"],
    memoryScope: "own",
    actionTools: ["execTs", "nav", "cache"],
    output: "wolfram-solution",
    defaultReads: ["context", "conclusion"],
    acceptanceRole: "writer",
    parent: "solver",
    generation: 5,
    differentiation: "专业计算任务诱导——符号代数推导与数值复核需要 Wolfram Engine 许可运行时，从 solver 分出符号数学专精",
    loadPolicyRef: "professional:symbolic-mathematician:v1",
  }),
  freezeRole({
    id: "technical-educator",
    tags: ["technical-educator", "jupyter-notebook", "notebook-authoring"],
    prompt: "你是技术教育者——消费已验证 Professional Job Result，产出可执行 Notebook、环境锁与教学清单。你只读 artifact（fs 只读面）并经 jupyter 适配器发布 Notebook；不继承通用 shell、化学软件或证明器权限。需要新计算时必须委派给对应专业 Role。",
    description: "技术教育者（writer 子类型——可执行 Notebook/环境锁/教学清单；jupyter 适配器）",
    thinking: "medium",
    capabilities: ["memory", "readSource", "readText", "fs"],
    memoryScope: "own",
    actionTools: ["execTs", "nav", "cache"],
    output: "notebook",
    defaultReads: ["reviewed-result", "context"],
    acceptanceRole: "writer",
    parent: "writer",
    generation: 4,
    differentiation: "专业计算教程任务诱导——消费已验证 job artifact 并发布可执行 Notebook，从 writer 分出 Jupyter 教学专精",
    loadPolicyRef: "professional:technical-educator:v1",
  }),
]) as unknown as RoleDefinition[];

/**
 * role → professional runtime 查询（唯一事实源 = professional-runtime.ts 的 allowlist）。
 * 未知角色返回空数组；computational-chemist 返回 psi4 + quantum-espresso 双 runtime。
 */
export function professionalRuntimeIdsForRole(roleId: string): readonly ProfessionalRuntimeId[] {
  const ids: ProfessionalRuntimeId[] = [];
  for (const [runtimeId, roleIds] of Object.entries(PROFESSIONAL_RUNTIME_ROLE_ALLOWLIST) as Array<[ProfessionalRuntimeId, readonly string[]]>) {
    if (roleIds.includes(roleId)) ids.push(runtimeId);
  }
  return Object.freeze(ids);
}

// ─── 五个责任/预算 fixture（共享 index/wiki 区域；过 N28 容量/预算校验） ───

const freezeRegion = (def: MemoryRegion): MemoryRegion => Object.freeze({
  ...def,
  selector: Object.freeze({ ...def.selector }),
});

export const PROFESSIONAL_ROLE_REGIONS: readonly MemoryRegion[] = Object.freeze([
  freezeRegion({ regionId: "region:professional:index", revision: 1, selector: { memoryTypes: ["index"] }, estimatedWeight: 20 }),
  freezeRegion({ regionId: "region:professional:wiki", revision: 1, selector: { memoryTypes: ["wiki"] }, estimatedWeight: 30 }),
  freezeRegion({ regionId: "region:professional:skill", revision: 1, selector: { memoryTypes: ["skill"] }, estimatedWeight: 30 }),
  freezeRegion({ regionId: "region:professional:log", revision: 1, selector: { memoryTypes: ["log"] }, estimatedWeight: 20 }),
  freezeRegion({ regionId: "region:professional:reviewed-result", revision: 1, selector: { kinds: ["reviewed-result", "professional-result"] }, estimatedWeight: 20 }),
]);

const workerFor = (roleId: string, workerId: string): WorkerReplicaRef => {
  const role = PROFESSIONAL_ROLES.find((r) => r.id === roleId);
  if (!role) throw new Error(`professional roles fixture: unknown role ${roleId}`);
  return Object.freeze({
    workerId,
    batchId: "batch-professional",
    role: Object.freeze({ roleId, revision: roleDefinitionRevision(role) }),
  });
};

export const PROFESSIONAL_ROLE_WORKERS: Readonly<Record<string, WorkerReplicaRef>> = Object.freeze({
  "assembly-engineer": workerFor("assembly-engineer", "10000000-0000-4000-8000-000000000101"),
  "computational-chemist": workerFor("computational-chemist", "10000000-0000-4000-8000-000000000102"),
  "lean4-prover": workerFor("lean4-prover", "10000000-0000-4000-8000-000000000103"),
  "symbolic-mathematician": workerFor("symbolic-mathematician", "10000000-0000-4000-8000-000000000104"),
  "technical-educator": workerFor("technical-educator", "10000000-0000-4000-8000-000000000105"),
});

const freezeResponsibility = (def: MemoryResponsibility): MemoryResponsibility => Object.freeze({ ...def });

/**
 * 共享区域责任分配（maxRegions=3 / maxPrimaryWeight=80 / maxSecondaryWeight=40 内）：
 *   - assembly-engineer 偏 skill/log（工具链），overlap 共享 index
 *   - computational-chemist 偏 wiki/index/log
 *   - lean4-prover 偏 index/wiki/skill
 *   - symbolic-mathematician 偏 wiki/index/skill
 *   - technical-educator 读 reviewed result/index/skill
 */
export const PROFESSIONAL_ROLE_RESPONSIBILITIES: ReadonlyMap<string, readonly MemoryResponsibility[]> = new Map([
  ["assembly-engineer", Object.freeze([
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["assembly-engineer"]!.workerId, regionId: "region:professional:skill", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 }),
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["assembly-engineer"]!.workerId, regionId: "region:professional:log", regionRevision: 1, kind: "primary", priority: 1, epoch: 1 }),
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["assembly-engineer"]!.workerId, regionId: "region:professional:index", regionRevision: 1, kind: "overlap", priority: 0, epoch: 1 }),
  ])],
  ["computational-chemist", Object.freeze([
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["computational-chemist"]!.workerId, regionId: "region:professional:wiki", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 }),
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["computational-chemist"]!.workerId, regionId: "region:professional:index", regionRevision: 1, kind: "primary", priority: 1, epoch: 1 }),
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["computational-chemist"]!.workerId, regionId: "region:professional:log", regionRevision: 1, kind: "primary", priority: 2, epoch: 1 }),
  ])],
  ["lean4-prover", Object.freeze([
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["lean4-prover"]!.workerId, regionId: "region:professional:index", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 }),
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["lean4-prover"]!.workerId, regionId: "region:professional:wiki", regionRevision: 1, kind: "primary", priority: 1, epoch: 1 }),
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["lean4-prover"]!.workerId, regionId: "region:professional:skill", regionRevision: 1, kind: "primary", priority: 2, epoch: 1 }),
  ])],
  ["symbolic-mathematician", Object.freeze([
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["symbolic-mathematician"]!.workerId, regionId: "region:professional:wiki", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 }),
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["symbolic-mathematician"]!.workerId, regionId: "region:professional:index", regionRevision: 1, kind: "primary", priority: 1, epoch: 1 }),
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["symbolic-mathematician"]!.workerId, regionId: "region:professional:skill", regionRevision: 1, kind: "primary", priority: 2, epoch: 1 }),
  ])],
  ["technical-educator", Object.freeze([
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["technical-educator"]!.workerId, regionId: "region:professional:reviewed-result", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 }),
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["technical-educator"]!.workerId, regionId: "region:professional:index", regionRevision: 1, kind: "primary", priority: 1, epoch: 1 }),
    freezeResponsibility({ workerId: PROFESSIONAL_ROLE_WORKERS["technical-educator"]!.workerId, regionId: "region:professional:skill", regionRevision: 1, kind: "primary", priority: 2, epoch: 1 }),
  ])],
]);

const freezeBudget = (b: CognitiveBudget): Readonly<CognitiveBudget> => Object.freeze({ ...b });

/** loadPolicyRef → 任务预算（每轴均 ≤ N28_FEASIBILITY_BUDGET.task 对应上限）。 */
export const PROFESSIONAL_ROLE_BUDGETS: ReadonlyMap<string, Readonly<CognitiveBudget>> = new Map<string, Readonly<CognitiveBudget>>([
  ["professional:assembly-engineer:v1", freezeBudget({ maxMemoryEntries: 8, maxMemoryChars: 4096, maxSkillIndexEntries: 8, maxActiveSkills: 4, maxSkillChars: 8192, maxTools: 8 })],
  ["professional:computational-chemist:v1", freezeBudget({ maxMemoryEntries: 8, maxMemoryChars: 4096, maxSkillIndexEntries: 8, maxActiveSkills: 4, maxSkillChars: 4096, maxTools: 8 })],
  ["professional:lean4-prover:v1", freezeBudget({ maxMemoryEntries: 8, maxMemoryChars: 4096, maxSkillIndexEntries: 8, maxActiveSkills: 4, maxSkillChars: 8192, maxTools: 8 })],
  ["professional:symbolic-mathematician:v1", freezeBudget({ maxMemoryEntries: 8, maxMemoryChars: 4096, maxSkillIndexEntries: 8, maxActiveSkills: 4, maxSkillChars: 8192, maxTools: 8 })],
  ["professional:technical-educator:v1", freezeBudget({ maxMemoryEntries: 4, maxMemoryChars: 2048, maxSkillIndexEntries: 4, maxActiveSkills: 2, maxSkillChars: 4096, maxTools: 4 })],
]);

/** 任务预算不得超过 N28 可行性基线（fixture 冻结自检）。 */
export function assertProfessionalRoleBudgetsWithinN28(): void {
  const base = N28_FEASIBILITY_BUDGET.task;
  for (const [ref, budget] of PROFESSIONAL_ROLE_BUDGETS) {
    for (const axis of Object.keys(base) as Array<keyof CognitiveBudget>) {
      if (budget[axis] > base[axis]) {
        throw new Error(`professional role budget ${ref} axis ${axis} ${budget[axis]} exceeds N28 base ${base[axis]}`);
      }
    }
  }
}
