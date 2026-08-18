import type { WorkerKernel } from "../interpreter/index.js";
import { tagRegistry } from "./tag-registry.js";
// 内置角色谱系（具体实现层——2026-08-12 分层：核心机制与本文件消费 impls 数据）
// 内置角色数据由装配层注入（2026-08-13 审计 P2——核心不再 import 实现层——见 setDefaultRoles）

export interface RoleDefinition {
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
  /** 探索核候选列表（backlog 差距 11——2026-08-12）：角色可显式声明可用的探索核语言集合
   *  （如 ["python","bash"]——A/B 并存：探索性任务可分别用不同语言核验证同一问题，
   *  探索空间按语言划分 asp.cd("python")/asp.cd("bash")）。未声明 → 沿用 capabilities 推断（现状）。 */
  exploreKernels?: string[];
  /** 动作面白名单（2026-08-12 工具面裁剪——目标驱动最小化）：声明后 LLM 只看到/只可调
   *  这些工具（族名展开见 TOOL_GROUPS——execTs/execPy/execBash/dev/debug/write/nav/cache）。
   *  未声明 → 全量兼容（扩展角色/自定义角色不受影响）。
   *  2026-08-14 N8：spaceMaint 族退役——空间生成走治理通道（spaceRegistry.createChild/unregister），
   *  worker 工具面不再有 asp.create/destroy。 */
  actionTools?: string[];
  /** Optional immutable policy reference; absence means the host system ceiling. */
  loadPolicyRef?: string;
}

/** @deprecated Use RoleDefinition. Kept while runtime call sites migrate by layer. */
export type WorkerRole = RoleDefinition;

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
  // known 集合含 governance（sensor/controller 系——显式可列；默认展开不含——MID 同款）
  const known = new Set([...allWorkerRoles(), ...midRoles, ...governanceRoles].map((r) => r.id));
  const specStr = spec as string;
  for (const part of specStr.split(",")) {
    // 角色 id 可含冒号（sensor:worker-opt）——copies 是末尾数字段——从右找数字段拆分
    // （2026-08-12 体系自制修复：split(":") 对含冒号 id 拆碎——MID 无冒号未暴露）
    const trimmed = part.trim();
    const ci = trimmed.lastIndexOf(":");
    const copiesRaw = ci > 0 && /^\d+$/.test(trimmed.slice(ci + 1)) ? trimmed.slice(ci + 1) : undefined;
    const roleId = copiesRaw !== undefined ? trimmed.slice(0, ci).trim() : trimmed;
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

/** 权重展开 → worker 角色列表（副本重复；含 0 副本过滤）
 * 2026-08-12 修复：按 weights 键展开（含显式启用的 governance/MID 角色——
 * 旧实现只遍历 allWorkerRoles——PTH_WORKER_ROLES 显式列出的 governance 被静默丢弃）。 */
export function expandRoleWeights(weights: Map<string, number>): WorkerRole[] {
  const byId = new Map([...allWorkerRoles(), ...midRoles, ...governanceRoles].map((r) => [r.id, r]));
  const out: WorkerRole[] = [];
  for (const [id, n] of weights) {
    const r = byId.get(id);
    if (!r) continue;   // 未知 id 静默忽略（parse 已校验——防御性）
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
    const knownSet = new Set([...allWorkerRoles(), ...midRoles, ...governanceRoles].map((r) => r.id));
    if (!knownSet.has(role)) throw new Error(`parseRoleWeights: 未知角色 "${role}"`);
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
  if (defaultRoles.some((r) => r.id === role.id) || extraRoles.some((r) => r.id === role.id)) {
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

// ── 内置角色装配状态（2026-08-13 审计 P2：核心不再 import 实现层——
//    assembly 层从 impls/roles/default-roles 取数据经 setDefaultRoles 注入）──
let originRole: WorkerRole | undefined;
let defaultRoles: WorkerRole[] = [];
let midRoles: WorkerRole[] = [];
let governanceRoles: WorkerRole[] = [];

/** 装配期注入：内置角色数据 + 标签注册（原模块顶层副作用随注入解除 TDZ 约束） */
export function setDefaultRoles(origin: WorkerRole, defaults: WorkerRole[], mid: WorkerRole[], governance: WorkerRole[]): void {
  originRole = origin;
  defaultRoles = defaults;
  midRoles = mid;
  governanceRoles = governance;
  // 内置角色标签注册（origin + DEFAULT_ROLES；MID_ROLES 是谱系结构层非派发目标——不注册）
  registerRoleTags(origin);
  for (const r of defaults) registerRoleTags(r);
  // governance 标签注册（sensor/controller 系显式启用后可派发——kind=governance）
  for (const r of governance) {
    for (const tag of r.tags) {
      tagRegistry.register({ name: tag, kind: "governance", description: "治理角色共享标签（" + r.id + " 等）", registeredBy: "governance:" + r.id });
    }
  }
}

/** 全部角色（Origin 根 + 内置 + 扩展——routeTaskRole/worker 构成统一谱系） */
export function allWorkerRoles(): WorkerRole[] {
  return [...(originRole ? [originRole] : []), ...defaultRoles, ...extraRoles];
}

/** 规划系角色判定（2026-08-14 T1/T2 裁决：注入策略按角色类分化——
 *  规划系 = planner / governor / controller 系 / sensor 系（worker-index 与角色文档 eager 注入）；
 *  执行族/信息族走 lazy 锚点（memory.query 按需展开）。 */
export function isPlanningRole(roleId: string | undefined): boolean {
  if (!roleId) return false;
  return roleId === "planner" || roleId === "governor" || roleId === "controller" || roleId === "sensor" || roleId.startsWith("controller:") || roleId.startsWith("sensor:");
}

/**
 * worker-index 渲染（2026-08-13：planner 的 worker 类型获取通道）。
 * 从 allWorkerRoles 渲染可派发角色清单——每角色一行：id | 职责 | 标签 | 代数。
 * 双层供给：① agent-loop system prompt eager 注入（内存渲染——零 DB 往返）；
 * ② kind=worker-index 记忆条目（ts 程序内 memory.query 可查——lazy/自助）。
 */
export function renderWorkerIndex(): string {
  const lines = allWorkerRoles().map((r) => {
    const tags = (r.tags ?? []).join("/") || "-";
    const desc = (r.description ?? r.prompt ?? "").replace(/\s+/g, " ").slice(0, 40);
    return `- ${r.id} [${tags}] gen${r.generation ?? 0}（父 ${r.parent ?? "-"}）：${desc}`;
  });
  return `【可用 worker 角色清单（规划/路由/协作时参考——${lines.length} 个）】
${lines.join("\n")}`;
}

/** 全部可派发角色（worker + 中间层 + governance——router/batch/expand 统一查找面；
 *  MID/governance 须显式 PTH_WORKER_ROLES 启用才会进 batch——但路由校验/查找不因未启用而拒绝） */
export function allKnownRoles(): WorkerRole[] {
  return [...allWorkerRoles(), ...midRoles, ...governanceRoles];
}

/** 按 id 查找（全已知面——含 governance/MID） */
export function knownRoleById(id: string): WorkerRole | undefined {
  return allKnownRoles().find((r) => r.id === id);
}

/**
 * 中间层角色（谱系树结构层——generation=1——Origin 的初代分化）：
 * 三族按任务性质划分——执行族（做实事）/信息族（取信息）/治理族（质量与秩序）。
 * 默认不进 batch（池容量安全——叶子角色直接接任务）；PTH_WORKER_ROLES 显式启用时
 * 接族内泛化任务（未明确特化方向的族级任务）；也是未来三代分化的挂载点。
 */

export function getExtraRoles(): WorkerRole[] { return [...extraRoles]; }

/** 谱系全量角色（含 Origin 根——lineage 查询/文档注入用；batch 构成仍由 allWorkerRoles/PTH_WORKER_ROLES 决定） */
export function allLineageRoles(): WorkerRole[] {
  const roles = allWorkerRoles();
  const origin = originRole;
  const base = origin && !roles.some((r) => r.id === origin.id) ? [origin, ...roles] : roles;
  const withMid = [...base];
  for (const mid of midRoles) if (!withMid.some((r) => r.id === mid.id)) withMid.push(mid);
  for (const g of governanceRoles) if (!withMid.some((r) => r.id === g.id)) withMid.push(g);
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
  const rootRole = originRole ? (byId.get(originRole.id) ?? originRole) : roles[0];
  if (!rootRole) throw new Error("buildRoleLineage: 角色集为空（未注入内置角色——先 setDefaultRoles）");
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

// governance 标签注册移入 setDefaultRoles（2026-08-13 审计 P2——随装配执行）
