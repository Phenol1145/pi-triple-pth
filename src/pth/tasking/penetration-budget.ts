/**
 * tasking/penetration-budget.ts —— N15 B2 穿透执行预算（docs/pth/n15-lane-b1-b2-a4-design.md §1.3）。
 *
 * 纯函数模块：把「父任务内同步子 agent 调用」的累计步数收进两条预算线——
 *   1. 单次穿透调用步数上限（PTH_PENETRATION_MAX_STEPS）；
 *   2. 同一父任务全部穿透调用的累计步数上限（PTH_PENETRATION_TASK_BUDGET_STEPS）。
 *
 * 语义钉死（设计文档裁决）：
 *   - 预算只限步数（v1 不折算 token/时长）；
 *   - 预算耗尽 = 调用失败（父可回退 tasks.delegate，不自动回退、不静默截断）；
 *   - 单次预算命中 maxSteps 时不额外扣满——按实际 steps 记账（失败也消耗，防重试放大）。
 */

export interface PenetrationLedger {
  calls: number;
  steps: number;
}

export interface PenetrationBudgetConfig {
  /** 单次穿透调用的子 agent 步数上限（PTH_PENETRATION_MAX_STEPS） */
  maxSteps: number;
  /** 同一父任务全部穿透调用的累计步数上限（PTH_PENETRATION_TASK_BUDGET_STEPS） */
  taskBudgetSteps: number;
  /** 单次穿透子 agent 超时（PTH_PENETRATION_TIMEOUT_MS，传给 runAgentTask timeoutMs） */
  timeoutMs: number;
}

export interface PenetrationChildBudget {
  ok: true;
  /** min(单次上限, 剩余累计额度)，且至少 1 */
  maxSteps: number;
  timeoutMs: number;
  /** 本次执行后预计剩余（调用方以实际 steps 修正） */
  remaining: number;
}

export interface PenetrationBudgetResult {
  ok: boolean;
  budget?: PenetrationChildBudget;
  error?: string;
}

/**
 * 调用前预算裁决：
 *   used = ledger.steps；remaining = taskBudgetSteps - used；
 *   remaining <= 0 → { ok:false, error: penetrationBudgetError(...) }；
 *   maxSteps = Math.max(1, Math.min(cfg.maxSteps, remaining))。
 */
export function childBudgetFor(
  ledger: PenetrationLedger,
  cfg: PenetrationBudgetConfig,
): PenetrationBudgetResult {
  const used = ledger.steps;
  const remaining = cfg.taskBudgetSteps - used;
  if (remaining <= 0) {
    return { ok: false, error: penetrationBudgetError(cfg, used) };
  }
  const maxSteps = Math.max(1, Math.min(cfg.maxSteps, remaining));
  return {
    ok: true,
    budget: {
      ok: true,
      maxSteps,
      timeoutMs: cfg.timeoutMs,
      remaining: remaining - maxSteps,
    },
  };
}

/** 调用完成结算：无论成败都按实际 steps 记账（失败也消耗预算，防重试放大）。 */
export function recordPenetrationUse(
  ledger: PenetrationLedger,
  steps: number,
): PenetrationLedger {
  return { calls: ledger.calls + 1, steps: ledger.steps + steps };
}

/**
 * 预算耗尽错误文案（父任务 id 由调用方拼接在末尾）。
 * 文案契约必须包含：穿透执行预算耗尽 / PTH_PENETRATION_TASK_BUDGET_STEPS /
 * 改走 tasks.delegate 或收敛穿透调用。
 */
export function penetrationBudgetError(cfg: PenetrationBudgetConfig, usedSteps: number): string {
  return `穿透执行预算耗尽：同一父任务累计穿透 ${usedSteps} 步已达上限 ${cfg.taskBudgetSteps}（PTH_PENETRATION_TASK_BUDGET_STEPS）——请改走 tasks.delegate 或收敛穿透调用`;
}
