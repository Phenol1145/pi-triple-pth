import type { WorkerKernel } from "../interpreter/index.js";

export interface WorkerRole {
  id: string;
  labelPatterns: string[];
  prompt: string;
  /** 权限最小化（P3——capabilities 白名单——缺省全量兼容）；扩展角色可声明 */
  capabilities?: string[];
  /** memory 区域（P3——own=仅自己命名空间 / all=跨区特许——缺省 all 兼容） */
  memoryScope?: "own" | "all";
}

export const DEFAULT_ROLES: WorkerRole[] = [
  { id: "analyst", labelPatterns: ["analysis", "research"], prompt: "你是分析者——负责信息分析、数据洞察、研究报告撰写。" },
  { id: "planner", labelPatterns: ["plan", "design"], prompt: "你是计划者——负责任务分解、方案设计、步骤规划。" },
  { id: "developer", labelPatterns: ["implement", "code", "fix"], prompt: "你是开发者——负责代码实现、缺陷修复、技术交付。" },
  { id: "scout", labelPatterns: ["recon", "investigate"], prompt: "你是侦查者——负责信息收集、代码侦察、环境探查。" },
  { id: "memory-keeper", labelPatterns: ["memory", "organize"], prompt: "你是记忆维护者——负责记忆整理、知识沉淀、索引维护。" },
  { id: "acceptor", labelPatterns: ["accept", "verify"], prompt: "你是验收者——负责结果验证、质量检查、交付验收。" },
  { id: "human-interface", labelPatterns: ["human", "interact"], prompt: "你是人类交互者——负责与用户沟通、意图澄清、反馈传递。" },
  { id: "tester", labelPatterns: ["test", "qa", "verify-func"], prompt: "你是功能测试者——负责能力测试、上下文管理验证、memory 数据库使用验证、行为探索。" },
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
