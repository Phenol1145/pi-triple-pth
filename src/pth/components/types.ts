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
