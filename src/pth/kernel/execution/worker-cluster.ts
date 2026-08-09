import type { WorkerKernel } from "../interpreter/index.js";

export interface WorkerRole {
  id: string;
  labelPatterns: string[];
  prompt: string;
}

export const DEFAULT_ROLES: WorkerRole[] = [
  { id: "analyst", labelPatterns: ["analysis", "research"], prompt: "你是分析者——负责信息分析、数据洞察、研究报告撰写。" },
  { id: "planner", labelPatterns: ["plan", "design"], prompt: "你是计划者——负责任务分解、方案设计、步骤规划。" },
  { id: "developer", labelPatterns: ["implement", "code", "fix"], prompt: "你是开发者——负责代码实现、缺陷修复、技术交付。" },
  { id: "scout", labelPatterns: ["recon", "investigate"], prompt: "你是侦查者——负责信息收集、代码侦察、环境探查。" },
  { id: "memory-keeper", labelPatterns: ["memory", "organize"], prompt: "你是记忆维护者——负责记忆整理、知识沉淀、索引维护。" },
  { id: "acceptor", labelPatterns: ["accept", "verify"], prompt: "你是验收者——负责结果验证、质量检查、交付验收。" },
  { id: "human-interface", labelPatterns: ["human", "interact"], prompt: "你是人类交互者——负责与用户沟通、意图澄清、反馈传递。" },
];

// ── batch 构成参数化（2026-08-09：取消固定 7 角色限制）────────────────
// PTH_WORKER_ROLES="developer:3,analyst:2,planner:0" —— 角色:副本数，逗号分隔
//   未列出角色 → 默认 1 副本；副本 0 → 禁用该角色；不设置 → 现状（7 角色 ×1）
//   约束：副本 0-8；总 worker ≤ MAX_WORKERS（防误配失控）

export const MAX_WORKER_COPIES = 8;
export const MAX_TOTAL_WORKERS = 32;

/** 解析角色权重串 → Map（校验：角色合法/副本范围/总数上限）。空/undefined → 默认 7×1 */
export function parseRoleWeights(spec: string | undefined | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!spec || spec.trim() === "") {
    for (const r of DEFAULT_ROLES) out.set(r.id, 1);
    return out;
  }
  const known = new Set(DEFAULT_ROLES.map((r) => r.id));
  let total = 0;
  for (const part of spec.split(",")) {
    const [role, copiesRaw] = part.trim().split(":");
    const roleId = role?.trim();
    if (!roleId || !known.has(roleId)) throw new Error(`parseRoleWeights: 未知角色 "${roleId}"（可选: ${[...known].join("/")}）`);
    if (out.has(roleId)) throw new Error(`parseRoleWeights: 角色重复 "${roleId}"`);
    const copies = copiesRaw === undefined || copiesRaw.trim() === "" ? 1 : Number(copiesRaw.trim());
    if (!Number.isInteger(copies) || copies < 0 || copies > MAX_WORKER_COPIES) {
      throw new Error(`parseRoleWeights: ${roleId} 副本数须为 0-${MAX_WORKER_COPIES}（got ${copiesRaw}）`);
    }
    out.set(roleId, copies);
    total += copies;
  }
  // 未列出的角色默认 1（保持全角色覆盖语义）
  for (const r of DEFAULT_ROLES) if (!out.has(r.id)) out.set(r.id, 1);
  if (total > MAX_TOTAL_WORKERS) throw new Error(`parseRoleWeights: 总 worker ${total} 超上限 ${MAX_TOTAL_WORKERS}`);
  return out;
}

/** 权重展开 → worker 角色列表（副本重复；含 0 副本过滤） */
export function expandRoleWeights(weights: Map<string, number>): WorkerRole[] {
  const out: WorkerRole[] = [];
  for (const r of DEFAULT_ROLES) {
    const n = weights.get(r.id) ?? 1;
    for (let i = 0; i < n; i++) out.push(r);
  }
  return out;
}

export interface WorkerClusterDeps {
  kernelFactory: (role: WorkerRole) => WorkerKernel;
  taskStore: unknown;        // Spec C TaskStore（Task 2 接入）
  workspaceMgr: unknown;     // Task 3 接入
}

/** worker 簇：每 batch = 全角色 worker ×1（v1，裁决 14） */
export function createWorkerCluster(deps: WorkerClusterDeps): Map<string, WorkerKernel> {
  const map = new Map<string, WorkerKernel>();
  for (const role of DEFAULT_ROLES) {
    map.set(role.id, deps.kernelFactory(role));
  }
  return map;
}
