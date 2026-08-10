import type { WorkerKernel } from "../interpreter/index.js";

export interface WorkerRole {
  id: string;
  labelPatterns: string[];
  prompt: string;
  /** 权限最小化（P3——capabilities 白名单——缺省全量兼容）；扩展角色可声明
   *  PTC 范式下的"工具白名单" = 访问权限：角色能调用的 capability 函数
   *  （fs/python/bash/c/memory/readSource/readText/web/llm/state/skills/tasks 等） */
  capabilities?: string[];
  /** memory 区域（P3——own=仅自己命名空间 / all=跨区特许——缺省 all 兼容） */
  memoryScope?: "own" | "all";
  /** 推理深度（pi-subagent 启发——角色智力分配：决策/审查 high——探索 low——调研 medium）
   *  v1 仅声明（谱系元数据——后续传 LLM thinking 参数） */
  thinking?: "high" | "medium" | "low";
  /** 一句话职责（谱系文档/能力索引用） */
  description?: string;
  /** 产出约定（角色默认产出语义——scout=context/planner=plan——done result 结构指引） */
  output?: string;
  /** 默认读取（角色间产物约定——defaultReads 引用的上游产物——memory 查询指引） */
  defaultReads?: string[];
  /** 验收角色（pi-subagent 启发——read-only=只读审查（不能提交产物）/writer=可写交付）
   *  v1 仅声明（谱系元数据——后续 done 限制） */
  acceptanceRole?: "read-only" | "writer";
  /** 父角色（树状谱系——分化来源；Origin 的 parent 不存在=根） */
  parent?: string;
  /** 代数（Origin=0——初代分化=1——逐代递增） */
  generation?: number;
  /** 分化诱导（什么任务类型/为什么从父角色分化——分化理由——refine 任务 3 的 rationale 落此） */
  differentiation?: string;
}

/**
 * Origin —— 角色谱系的根（全能角色——用户设计：最开始只有 Origin，任务分化诱导逐渐形成更多角色）。
 *
 * 定位：
 *  - 谱系树的根（parent 不存在 / generation=0）——所有角色的分化起点
 *  - 可选运行：默认不进 batch 构成（8 角色已分工）；PTH_WORKER_ROLES 显式含 "origin" 时启用——
 *    全能兜底（处理所有任务类型——完整 capabilities——无访问权限收窄）
 *  - 分化演练起点：全新任务领域可先让 Origin 承接 → refine 任务 3 观察分化建议 → 监督批准 → 新角色
 */
export const ORIGIN_ROLE: WorkerRole = {
  id: "origin",
  labelPatterns: ["*"],   // 全能——匹配一切（路由兜底语义——实际路由：显式 flow.role=origin 或 PTH_WORKER_ROLES 启用后 hash）
  prompt: "你是 Origin——PTH 角色谱系的全能起点角色。你不预设专门化方向：按任务本身的需求组合全部可用能力完成。执行中注意识别任务内可区分的子任务模式（探索/实现/验证/调研等）——你的 refine 会分析这些模式，作为后续角色分化的诱导依据。",
  description: "全能起点（谱系之根——generation 0——所有角色从 Origin 分化而来）",
  thinking: "high",
  acceptanceRole: "writer",
  generation: 0,
  differentiation: "（根——无分化来源）",
};

// 角色谱系 v1 元数据（pi-subagent 启发——参考 docs/pth/role-lineage-v1.md）：
//   thinking=推理深度 / capabilities=PTC 访问权限 / output=产出约定 / defaultReads=角色间产物约定
//   / acceptanceRole=验收角色——谱系元数据声明（thinking 传 LLM/acceptanceRole done 限制后续实现）
export const DEFAULT_ROLES: WorkerRole[] = [
  { id: "analyst", labelPatterns: ["analysis", "research"], prompt: "你是分析者——负责信息分析、数据洞察、研究报告撰写。",
    description: "信息分析与数据洞察（researcher 对应）", thinking: "medium",
    capabilities: ["fs", "memory", "readSource", "readText", "web", "python", "bash"], output: "research",
    parent: "origin", generation: 1, differentiation: "分析调研类任务诱导——数据洞察/报告撰写需要 web 与数据能力的特化" },
  { id: "planner", labelPatterns: ["plan", "design"], prompt: "你是计划者——负责任务分解、方案设计、步骤规划。",
    description: "上下文→实施计划（只读——产出计划文档）", thinking: "high",
    capabilities: ["fs", "memory", "readSource", "readText"], output: "plan", defaultReads: ["context"], acceptanceRole: "read-only",
    parent: "origin", generation: 1, differentiation: "规划类任务诱导——方案设计只需读取/推理——收窄为只读访问权限" },
  { id: "developer", labelPatterns: ["implement", "code", "fix"], prompt: "你是开发者——负责代码实现、缺陷修复、技术交付。",
    description: "实现与开发（worker 对应——narrow coherent edits）", thinking: "high",
    output: "implementation", defaultReads: ["context", "plan"], acceptanceRole: "writer",
    parent: "origin", generation: 1, differentiation: "实现类任务诱导——代码交付需要完整执行能力与写入权限" },
  { id: "scout", labelPatterns: ["recon", "investigate"], prompt: "你是侦查者——负责信息收集、代码侦察、环境探查。",
    description: "快速侦察——压缩上下文交接下游（thinking low——快）", thinking: "low",
    capabilities: ["fs", "memory", "readSource", "readText", "bash"], output: "context",
    parent: "origin", generation: 1, differentiation: "侦察类任务诱导——快速信息收集不需要深推理——thinking low 特化换速度" },
  { id: "memory-keeper", labelPatterns: ["memory", "organize"], prompt: "你是记忆维护者——负责记忆整理、知识沉淀、索引维护。",
    description: "记忆整理与知识沉淀（PTH 特色——记忆系统维护）", thinking: "medium",
    capabilities: ["memory", "fs", "readSource"], output: "memory",
    parent: "origin", generation: 1, differentiation: "记忆维护类任务诱导——知识沉淀/索引维护围绕 memory 能力收窄" },
  { id: "acceptor", labelPatterns: ["accept", "verify"], prompt: "你是验收者——负责结果验证、质量检查、交付验收。",
    description: "结果验证与交付验收（reviewer 对应——只读审查）", thinking: "high",
    capabilities: ["fs", "memory", "readSource", "readText", "python", "bash"], defaultReads: ["plan", "progress"], acceptanceRole: "read-only",
    parent: "origin", generation: 1, differentiation: "验收类任务诱导——质量检查需要执行验证但不应修改产物——只读审查特化" },
  { id: "human-interface", labelPatterns: ["human", "interact"], prompt: "你是人类交互者——负责与用户沟通、意图澄清、反馈传递。",
    description: "人类需求兜底（PTH 特色——升级机制）", thinking: "high", acceptanceRole: "writer",
    parent: "origin", generation: 1, differentiation: "人类交互类任务诱导——意图澄清/反馈传递需要完整沟通能力与决策升级" },
  { id: "tester", labelPatterns: ["test", "qa", "verify-func"], prompt: "你是功能测试者——负责能力测试、上下文管理验证、memory 数据库使用验证、行为探索。",
    description: "能力测试与行为验证", thinking: "high",
    capabilities: ["fs", "memory", "readSource", "readText", "python", "bash", "c"], acceptanceRole: "writer",
    parent: "origin", generation: 1, differentiation: "测试类任务诱导——能力/行为验证需要全部执行核（含 c 编译核）写测试产物" },
];

// ── batch 构成参数化（2026-08-09：取消固定 7 角色限制）────────────────
// PTH_WORKER_ROLES="developer:3,analyst:2,planner:0" —— 角色:副本数，逗号分隔
//   未列出角色 → 默认 1 副本；副本 0 → 禁用该角色；不设置 → 现状（7 角色 ×1）
//   约束：副本 0-8；总 worker ≤ MAX_WORKERS（防误配失控）

export const MAX_WORKER_COPIES = 8;
export const MAX_TOTAL_WORKERS = 32;

/** 解析角色权重串 → Map（校验：角色合法/副本范围/总数上限）。空/undefined → 默认 7×1 */
export function parseRoleWeights(spec: string | undefined | null | Record<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  // 对象输入（profile.weights 面——未列出默认 1）
  if (spec && typeof spec === "object") {
    for (const [role, copies] of Object.entries(spec)) out.set(role, copies);
    for (const r of allWorkerRoles()) if (!out.has(r.id)) out.set(r.id, 1);
    validateWeights(out);
    return out;
  }
  if (!spec || (spec as string).trim() === "") {
    for (const r of allWorkerRoles()) out.set(r.id, 1);
    return out;
  }
  const known = new Set(allWorkerRoles().map((r) => r.id));
  const specStr = spec as string;
  for (const part of specStr.split(",")) {
    const [role, copiesRaw] = part.trim().split(":");
    const roleId = role?.trim();
    if (!roleId || !known.has(roleId)) throw new Error(`parseRoleWeights: 未知角色 "${roleId}"（可选: ${[...known].join("/")}）`);
    if (out.has(roleId)) throw new Error(`parseRoleWeights: 角色重复 "${roleId}"`);
    const copies = copiesRaw === undefined || copiesRaw.trim() === "" ? 1 : Number(copiesRaw.trim());
    out.set(roleId, copies);
  }
  // 未列出的角色默认 1（保持全角色覆盖语义——含扩展角色）
  for (const r of allWorkerRoles()) if (!out.has(r.id)) out.set(r.id, 1);
  validateWeights(out);
  return out;
}

/** 权重展开 → worker 角色列表（副本重复；含 0 副本过滤） */
export function expandRoleWeights(weights: Map<string, number>): WorkerRole[] {
  const out: WorkerRole[] = [];
  for (const r of allWorkerRoles()) {
    const n = weights.get(r.id) ?? 1;
    for (let i = 0; i < n; i++) out.push(r);
  }
  return out;
}

// ── 资源分配策略抽象（2026-08-09：k8s 调度思想 + 可扩展算法点）────────────────
// 策略产出 BatchProfile → profileToWeights 序列化 → PTH_WORKER_ROLES env → fork 子进程（无感知）。
// 未来新算法（负载预测/装箱/反亲和…）：实现 BatchCompositionStrategy + 注册即可。

export type BatchProfile =
  | { mode: "balanced"; weights?: Record<string, number> }   // 角色分散（混合负载）
  | { mode: "reinforced"; role: string; copies: number }     // 单角色堆叠（瓶颈攻坚）

/** 调度上下文——策略决策的输入信号 */
export interface SchedulingContext {
  pendingByRole: Record<string, number>;                     // 各角色队列深度
  activeBatches: Array<{ id: string; mode: string; roles: string[] }>;
  poolCapacity: number;                                      // sandbox kernel 池容量
  limits: { maxTotalWorkers: number };
}

/** batch 构成策略接口——资源分配算法插件点 */
export interface BatchCompositionStrategy {
  readonly id: string;
  compose(ctx: SchedulingContext): BatchProfile;
}

/** 内置策略：均衡（权重展开——默认 7×1） */
export const balancedStrategy: BatchCompositionStrategy = {
  id: "balanced",
  compose: () => ({ mode: "balanced" }),
};

/** 内置策略：强化（单角色 × copies——瓶颈攻坚） */
export const reinforcedStrategy: BatchCompositionStrategy = {
  id: "reinforced",
  compose: (ctx) => {
    // v1 简化：取积压最深的角色（descheduler 思想）——copies 默认 2
    const entries = Object.entries(ctx.pendingByRole).sort((a, b) => b[1] - a[1]);
    const role = entries[0]?.[0] ?? "developer";
    return { mode: "reinforced", role, copies: 2 };
  },
};

/** 策略注册表（可插拔） */
export const COMPOSITION_STRATEGIES: Record<string, BatchCompositionStrategy> = {
  balanced: balancedStrategy,
  reinforced: reinforcedStrategy,
};

/** BatchProfile → 权重 Map（序列化面——PTH_WORKER_ROLES env 统一表达） */
export function profileToWeights(profile: BatchProfile): Map<string, number> {
  if (profile.mode === "balanced") {
    if (profile.weights) return parseRoleWeights(profile.weights);
    return parseRoleWeights(undefined);   // 默认 7×1
  }
  // reinforced：单角色 × copies，其余 0（禁用——含扩展角色）
  const weights = new Map<string, number>();
  for (const r of allWorkerRoles()) weights.set(r.id, r.id === profile.role ? profile.copies : 0);
  validateWeights(weights);
  return weights;
}

/** 权重校验（parseRoleWeights 的独立面——供 profileToWeights 复用） */
export function validateWeights(weights: Map<string, number>): void {
  let total = 0;
  for (const [role, copies] of weights) {
    if (!allWorkerRoles().some((r) => r.id === role)) throw new Error(`parseRoleWeights: 未知角色 "${role}"`);
    if (!Number.isInteger(copies) || copies < 0 || copies > MAX_WORKER_COPIES) {
      throw new Error(`parseRoleWeights: ${role} 副本数须为 0-${MAX_WORKER_COPIES}`);
    }
    total += copies;
  }
  if (total > MAX_TOTAL_WORKERS) throw new Error(`parseRoleWeights: 总 worker ${total} 超上限 ${MAX_TOTAL_WORKERS}`);
}

/** 权重序列化 → env 串（"developer:2,analyst:1,..."） */
export function weightsToEnv(weights: Map<string, number>): string {
  return [...weights.entries()].map(([r, n]) => `${r}:${n}`).join(",");
}

// ── 角色注册表（兼容性扩展接口——正交角色谱系动态扩展）────────────────
// 内置 DEFAULT_ROLES + 扩展角色（ExtRegistry 装载注册）——routeTaskRole/worker 构成统一谱系。

let extraRoles: WorkerRole[] = [];

/** 注册扩展角色（id 冲突拒绝——防覆盖内置/已有扩展角色） */
export function registerWorkerRole(role: WorkerRole): void {
  if (DEFAULT_ROLES.some((r) => r.id === role.id) || extraRoles.some((r) => r.id === role.id)) {
    throw new Error(`registerWorkerRole: 角色 "${role.id}" 已存在（id 冲突）`);
  }
  // labelPatterns 重叠校验（正交角色谱系——任务类型不重叠）
  const allPatterns = [...DEFAULT_ROLES, ...extraRoles].flatMap((r) => r.labelPatterns);
  for (const pat of role.labelPatterns) {
    if (allPatterns.some((p) => p.includes(pat) || pat.includes(p))) {
      throw new Error(`registerWorkerRole: 角色 "${role.id}" 的 labelPattern "${pat}" 与已有角色重叠`);
    }
  }
  extraRoles.push(role);
}

/** 全部角色（内置 + 扩展——routeTaskRole/worker 构成统一谱系） */
export function allWorkerRoles(): WorkerRole[] {
  return [...DEFAULT_ROLES, ...extraRoles];
}

/** 已注册扩展角色（监控/调试） */
export function getExtraRoles(): WorkerRole[] { return [...extraRoles]; }

/** 谱系全量角色（含 Origin 根——lineage 查询/文档注入用；batch 构成仍由 allWorkerRoles/PTH_WORKER_ROLES 决定） */
export function allLineageRoles(): WorkerRole[] {
  const roles = allWorkerRoles();
  return roles.some((r) => r.id === ORIGIN_ROLE.id) ? roles : [ORIGIN_ROLE, ...roles];
}

/** 谱系树节点（树状结构——分化路径可视化） */
export interface RoleLineageNode {
  role: WorkerRole;
  children: RoleLineageNode[];
}

/**
 * 构建角色谱系树（树状分化结构——用户设计：Origin 根 → 任务分化诱导逐代生长）。
 * parent 缺失/未知 → 挂 Origin 下（兼容：扩展角色未填 parent 视为初代分化）。
 */
export function buildRoleLineage(roles: WorkerRole[] = allLineageRoles()): RoleLineageNode {
  const byId = new Map(roles.map((r) => [r.id, r] as const));
  const rootRole = byId.get(ORIGIN_ROLE.id) ?? ORIGIN_ROLE;
  const nodes = new Map<string, RoleLineageNode>(roles.map((r) => [r.id, { role: r, children: [] }]));
  const root = nodes.get(rootRole.id) ?? { role: rootRole, children: [] };
  nodes.set(root.role.id, root);
  for (const role of roles) {
    if (role.id === root.role.id) continue;
    const node = nodes.get(role.id)!;
    const parentId = role.parent && byId.has(role.parent) ? role.parent : root.role.id;
    nodes.get(parentId)!.children.push(node);
  }
  // 稳定排序：generation 升序 → id 字典序（树展示确定性）
  const sortRec = (n: RoleLineageNode) => {
    n.children.sort((a, b) => (a.role.generation ?? 1) - (b.role.generation ?? 1) || a.role.id.localeCompare(b.role.id));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

/** 谱系树文本渲染（ptl hub lineage tree / role-doc 谱系段落共用） */
export function renderRoleLineage(root: RoleLineageNode = buildRoleLineage()): string {
  const lines: string[] = [];
  const walk = (n: RoleLineageNode, prefix: string, isLast: boolean, isRoot: boolean) => {
    const r = n.role;
    const label = `${r.id}${r.thinking ? `（${r.thinking}）` : ""}`;
    if (isRoot) lines.push(label);
    else lines.push(`${prefix}${isLast ? "└─" : "├─"} ${label}`);
    const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
    n.children.forEach((c, i) => walk(c, childPrefix, i === n.children.length - 1, false));
  };
  walk(root, "", true, true);
  return lines.join("\n");
}

/** 测试用：清扩展角色 */
export function resetExtraRoles(): void { extraRoles = []; }

export interface WorkerClusterDeps {
  kernelFactory: (role: WorkerRole) => WorkerKernel;
  taskStore: unknown;        // Spec C TaskStore（Task 2 接入）
  workspaceMgr: unknown;     // Task 3 接入
}

/** worker 簇：每 batch = 全角色 worker ×1（v1，裁决 14） */
export function createWorkerCluster(deps: WorkerClusterDeps): Map<string, WorkerKernel> {
  const map = new Map<string, WorkerKernel>();
  for (const role of allWorkerRoles()) {
    map.set(role.id, deps.kernelFactory(role));
  }
  return map;
}
