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
    task: {
      title: "记忆维护巡检（归档候选提案）",
      text: "你是记忆维护巡检任务。用 memory.query 检查：① status='draft' 且长期未更新的条目；② 低 hit_count 的 official 条目；③ 重复条目。对确认应归档的目标，用 memory.write 落一条 kind='memory-admin-proposal' 的 draft 提案，content 为 JSON：{\"action\":\"archive\",\"target\":\"<条目id>\",\"rationale\":\"<归档理由>\"}。不要直接归档/删除——监督层批准后由 memory-admin approve 执行。本次未发现候选则 done 空清单说明即可。",
      role: "memory-keeper",
      tags: ["memory", "organize", "auto-sweep"],
    },
    enabled: true,
  };
}
