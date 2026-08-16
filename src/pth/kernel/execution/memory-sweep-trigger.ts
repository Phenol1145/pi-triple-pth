/**
 * memory-sweep-trigger.ts —— 记忆维护巡检系统 trigger（2026-08-15 B1 / N7）。
 *
 * T7 归档闭环执行端已实装（memory-admin.ts：draft 提案 → 监督批准 → 执行）。
 * 本模块补上「定期触发」这一环：每天（可配）派发一次 memory-keeper 巡检任务，
 * 扫描过期 draft/低命中条目并生成 memory-admin-proposal（archive 提案）——不直接归档。
 */

import type { TriggerDef } from "./trigger-engine.js";

export const MEMORY_SWEEP_TRIGGER_NAME = "memory-maintenance-sweep";

export function memorySweepSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PTH_MEMORY_SWEEP_SECONDS ?? 24 * 60 * 60);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function buildMemorySweepTrigger(env: NodeJS.ProcessEnv = process.env): TriggerDef | null {
  const everySec = memorySweepSeconds(env);
  if (everySec <= 0) return null;   // PTH_MEMORY_SWEEP_SECONDS=0 显式禁用
  return {
    name: MEMORY_SWEEP_TRIGGER_NAME,
    schedule: { everySec },
    // 任务模板统一收口（A+，2026-08-16）：提示词迁入 TASK_TEMPLATES（hidden 系统内部模板），
    // trigger 只持引用 + 路由（role=memory-keeper；tags 为已注册标签）。
    task: { template: "memory-sweep", role: "memory-keeper", tags: ["memory", "organize"] },
    enabled: true,
  };
}
