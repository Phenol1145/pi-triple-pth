/**
 * components/types.ts —— 组件层共享类型（2026-08-13 审计 P1：COMPONENT_TYPES/ComponentType 从 store.ts 抽出）。
 *
 * slot-binding.ts 与 store.ts 双向取类型形成类型级循环——常量与类型归位到本文件后，
 * 运行时边 store→slot-binding 保持单向；类型边 slot-binding→types、store→types——无环。
 */

export const COMPONENT_TYPES = [
  "agent-program",
  "scheduler",
  "optimizer",
  "memory-pack",
  "skeleton-update",
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

/**
 * 构件 manifest：type 分派；agent-program 时携带原 ProgramManifest 全部字段
 * （与 PTH ProgramManifest 同构，全部可选——非 agent 类型不携带这些字段）。
 */
export interface ComponentManifest {
  type: ComponentType;
  name: string;
  version?: string; // version-pin
  description?: string;
  payload?: Record<string, unknown>;
  targetSlot?: string; // 空位绑定（§5.2）
  legalAuth?: string; // 治理授权引用（§5.3）
  // agent-program 分支字段（等价映射）
  model?: string;
  provider?: string;
  thinking?: string;
  systemPrompt?: string;
  skills?: string[];
  tools?: string[];
  excludeTools?: string[];
  input?: { schema?: Record<string, unknown> };
  timeoutSec?: number;
}

export interface ComponentInfo {
  type: ComponentType;
  name: string;
  latestVersion: number;
  updatedAt: number;
}

export interface ComponentVersion {
  type: ComponentType;
  name: string;
  version: number;
  root: string; // absolute path to component directory on disk
  manifest: ComponentManifest;
}
