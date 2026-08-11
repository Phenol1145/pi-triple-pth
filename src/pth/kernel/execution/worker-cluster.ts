import type { WorkerKernel } from "../interpreter/index.js";
import { tagRegistry } from "./tag-registry.js";

export interface WorkerRole {
  id: string;
  /** 角色固定标签（tag-registry 路由唯一标准——精确匹配——分选器只认它） */
  tags: string[];
  prompt: string;
  /** 权限最小化（P3——capabilities 白名单——缺省全量兼容）；扩展角色可声明
   *  PTC 范式下的"工具白名单" = 访问权限：角色能调用的 capability 函数
   *  （fs/python/bash/c/memory/readSource/readText/web/llm/state/skills/tasks 等） */
  capabilities?: string[];
  /** memory 区域（P3——own=仅自己命名空间 / all=跨区特许——缺省 all 兼容） */
  memoryScope?: "own" | "all";
  /** 推理深度（pi-subagent 启发——角色智力分配：决策/审查 high——探索 low——调研 medium）
   *  2026-08-11 Agent-JIT 路径 B：thinking 已接线——agent-loop complete 传 reasoning_effort */
  thinking?: "high" | "medium" | "low";
  /** 模型覆盖（Agent-JIT 路径 B——窄域角色可声明更弱/更便宜的模型；缺省全局 PTH_AGENT_MODEL） */
  model?: string;
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
 *  - 常驻 worker（2026-08-10 任务池纯化 D7）：默认 batch 构成含 Origin ×1——升级链终点
 *    （terminal reject → trigger 转写 origin 标签 → Origin 全能力兜底完成；PTH_WORKER_ROLES
 *    可 origin:0 禁用）
 *  - 分化演练起点：全新任务领域可先让 Origin 承接 → refine 任务 3 观察分化建议 → 监督批准 → 新角色
 */
export const ORIGIN_ROLE: WorkerRole = {
  id: "origin",
  tags: ["origin"],   // 升级链终点标签（trigger 转写——任务池纯化设计 D3）
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
  { id: "analyst", tags: ["analysis", "research"], prompt: "你是分析者——负责信息分析、数据洞察、研究报告撰写。",
    description: "信息分析与数据洞察（researcher 对应）", thinking: "medium",
    capabilities: ["fs", "memory", "readSource", "readText", "web", "python", "bash"], output: "research",
    parent: "explorer", generation: 2, differentiation: "分析调研类任务诱导——数据洞察/报告撰写需要 web 与数据能力的特化" },
  { id: "planner", tags: ["plan", "design"], prompt: "你是计划者——负责任务分解、方案设计、步骤规划。",
    description: "上下文→实施计划（只读——产出计划文档）", thinking: "high",
    capabilities: ["fs", "memory", "readSource", "readText"], output: "plan", defaultReads: ["context"], acceptanceRole: "read-only",
    parent: "governor", generation: 2, differentiation: "规划类任务诱导——方案设计只需读取/推理——收窄为只读访问权限" },
  { id: "developer", tags: ["implement", "code", "fix"], prompt: "你是开发者——负责代码实现、缺陷修复、技术交付。",
    description: "实现与开发（worker 对应——narrow coherent edits）", thinking: "high",
    // 权限 v2 R4：显式声明（缺省全量废止）——core+data 全量，无管理面
    capabilities: ["python", "bash", "c", "fs", "web", "llm", "state", "ext", "env", "memory", "skills", "obs"],
    output: "implementation", defaultReads: ["context", "plan"], acceptanceRole: "writer",
    parent: "executor", generation: 2, differentiation: "实现类任务诱导——代码交付需要完整执行能力与写入权限" },
  { id: "scout", tags: ["recon", "investigate"], prompt: "你是侦查者——负责信息收集、代码侦察、环境探查。",
    description: "快速侦察——压缩上下文交接下游（thinking low——快）", thinking: "low",
    // Agent-JIT 路径 B：侦察窄域 → 低推理档 + 轻量模型声明（当前同全局——未来换便宜档只改此处）
    model: "deepseek-v4-flash",
    capabilities: ["fs", "memory", "readSource", "readText", "bash"], output: "context",
    parent: "explorer", generation: 2, differentiation: "侦察类任务诱导——快速信息收集不需要深推理——thinking low 特化换速度" },
  { id: "memory-keeper", tags: ["memory", "organize"], prompt: "你是记忆维护者——负责记忆整理、知识沉淀、索引维护。",
    description: "记忆整理与知识沉淀（PTH 特色——记忆系统维护）", thinking: "medium",
    capabilities: ["memory", "fs", "readSource"], output: "memory",
    parent: "governor", generation: 2, differentiation: "记忆维护类任务诱导——知识沉淀/索引维护围绕 memory 能力收窄" },
  // Agent-JIT 路径 B（2026-08-11）：热点任务分化——scout 侦察族内再分化出
  // memory-stats（generation 3）——"查记忆/计数/汇总"类高频任务专用：capabilities
  // 只留 memory（工具面最窄——in tokens 最小化）+ thinking low（out tokens 最小化）。
  // 验证闭环：tags ["stats"] 路由 → 同任务 out/in 均低于 scout。
  { id: "memory-stats", tags: ["stats", "count", "summarize"], prompt: "你是记忆统计员——专门统计记忆库条目：按 kind/tag 计数、汇总数量、报告统计结果。只做聚合统计——不做分析、不改数据、不写代码。",
    description: "记忆统计窄域（scout 分化——计数/汇总专用）", thinking: "low", model: "deepseek-v4-flash",
    capabilities: ["memory"], output: "stats",
    parent: "scout", generation: 3, differentiation: "统计类任务诱导——记忆计数是最高频侦察子模式——能力收窄至 memory 单包 + 低推理档" },
  { id: "acceptor", tags: ["accept", "verify"], prompt: "你是验收者——负责结果验证、质量检查、交付验收。",
    description: "结果验证与交付验收（reviewer 对应——只读审查）", thinking: "high",
    capabilities: ["fs", "memory", "readSource", "readText", "python", "bash"], defaultReads: ["plan", "progress"], acceptanceRole: "read-only",
    parent: "governor", generation: 2, differentiation: "验收类任务诱导——质量检查需要执行验证但不应修改产物——只读审查特化" },
  { id: "tester", tags: ["test", "qa", "verify-func"], prompt: "你是功能测试者——负责能力测试、上下文管理验证、memory 数据库使用验证、行为探索。",
    description: "能力测试与行为验证", thinking: "high",
    capabilities: ["fs", "memory", "readSource", "readText", "python", "bash", "c"], acceptanceRole: "writer",
    parent: "executor", generation: 2, differentiation: "测试类任务诱导——能力/行为验证需要全部执行核（含 c 编译核）写测试产物" },
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
  extraRoles.push(role);
  // 标签冲突由 tagRegistry.register 抛错接管（同名不同角色 → 冲突）
  registerRoleTags(role);
}

/** 角色固定标签挂载总表（重复注册幂等跳过；跨角色同名冲突抛错） */
function registerRoleTags(role: WorkerRole): void {
  for (const tag of role.tags) {
    tagRegistry.register({ name: tag, kind: "role", role: role.id, registeredBy: `role:${role.id}` });
  }
}

// 内置角色标签随模块加载注册（origin + DEFAULT_ROLES；MID_ROLES 是谱系结构层非派发目标——不注册）
registerRoleTags(ORIGIN_ROLE);
for (const r of DEFAULT_ROLES) registerRoleTags(r);

/** 全部角色（Origin 根 + 内置 + 扩展——routeTaskRole/worker 构成统一谱系） */
export function allWorkerRoles(): WorkerRole[] {
  return [ORIGIN_ROLE, ...DEFAULT_ROLES, ...extraRoles];
}

/**
 * 中间层角色（谱系树结构层——generation=1——Origin 的初代分化）：
 * 三族按任务性质划分——执行族（做实事）/信息族（取信息）/治理族（质量与秩序）。
 * 默认不进 batch（池容量安全——叶子角色直接接任务）；PTH_WORKER_ROLES 显式启用时
 * 接族内泛化任务（未明确特化方向的族级任务）；也是未来三代分化的挂载点。
 */
export const MID_ROLES: WorkerRole[] = [
  { id: "executor", tags: ["execute", "deliver"], prompt: "你是执行者——执行族中间层。负责族内泛化的任务交付（未明确开发/测试之分的执行任务）：按任务需求组合执行能力完成并交付产物。族内已有特化：developer（实现）/tester（验证）——若任务明确属于特化方向，在产物中注明建议路由。",
    description: "执行族中间层（泛化任务交付）", thinking: "high", acceptanceRole: "writer",
    parent: "origin", generation: 1, differentiation: "执行类任务族诱导——做事型任务（实现/构建/验证）从 Origin 分出独立分支" },
  { id: "explorer", tags: ["explore", "survey"], prompt: "你是探索者——信息族中间层。负责族内泛化的信息获取（未明确侦察/分析之分的探索任务）：快速定位信息源、收集并压缩上下文交接下游。族内已有特化：scout（快速侦察）/analyst（深度分析）——若任务明确属于特化方向，在产物中注明建议路由。",
    description: "信息族中间层（泛化信息获取）", thinking: "medium",
    capabilities: ["fs", "memory", "readSource", "readText", "web", "bash"], output: "context",
    parent: "origin", generation: 1, differentiation: "信息类任务族诱导——获取型任务（侦察/调研/分析）从 Origin 分出独立分支" },
  { id: "governor", tags: ["govern", "oversight"], prompt: "你是治理者——治理族中间层。负责族内泛化的质量与秩序任务（未明确规划/验收/记忆之分的治理任务）：审查现状、维护秩序、产出治理结论。族内已有特化：planner（规划）/acceptor（验收）/memory-keeper（记忆）——若任务明确属于特化方向，在产物中注明建议路由。",
    description: "治理族中间层（泛化质量与秩序）", thinking: "high", acceptanceRole: "read-only",
    capabilities: ["fs", "memory", "readSource", "readText", "python", "bash"],
    parent: "origin", generation: 1, differentiation: "治理类任务族诱导——秩序型任务（规划/验收/记忆维护）从 Origin 分出独立分支" },
];

/** 已注册扩展角色（监控/调试） */
export function getExtraRoles(): WorkerRole[] { return [...extraRoles]; }

/** 谱系全量角色（含 Origin 根——lineage 查询/文档注入用；batch 构成仍由 allWorkerRoles/PTH_WORKER_ROLES 决定） */
export function allLineageRoles(): WorkerRole[] {
  const roles = allWorkerRoles();
  const base = roles.some((r) => r.id === ORIGIN_ROLE.id) ? roles : [ORIGIN_ROLE, ...roles];
  const withMid = [...base];
  for (const mid of MID_ROLES) if (!withMid.some((r) => r.id === mid.id)) withMid.push(mid);
  return withMid;
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
