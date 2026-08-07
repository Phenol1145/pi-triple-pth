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
