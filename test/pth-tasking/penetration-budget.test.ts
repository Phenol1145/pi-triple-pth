import { describe, expect, it } from "vitest";
import {
  childBudgetFor,
  penetrationBudgetError,
  recordPenetrationUse,
  type PenetrationBudgetConfig,
  type PenetrationLedger,
} from "../../src/pth/tasking/penetration-budget.js";

/**
 * N15 B2 穿透执行预算（docs/pth/design/n15-lane-b1-b2-a4-design.md §1.3）纯函数测试。
 *
 * 规则钉死：
 *  - used = ledger.steps；remaining = taskBudgetSteps - used；
 *  - remaining <= 0 → ok:false + 错误文案；
 *  - maxSteps = max(1, min(单次上限, 剩余累计额度))；
 *  - 累计预算按实际 steps 结算（不按 maxSteps 扣满）。
 */

const CFG: PenetrationBudgetConfig = {
  maxSteps: 40,
  taskBudgetSteps: 80,
  timeoutMs: 300_000,
};

const LEDGER_ZERO: PenetrationLedger = { calls: 0, steps: 0 };

describe("N15 B2 penetration-budget：childBudgetFor（累计额度/单次上限取 min）", () => {
  it("累计未消耗：单次上限 = min(单次 40, 剩余 80) = 40，预计剩余 40", () => {
    const r = childBudgetFor(LEDGER_ZERO, CFG);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.budget).toEqual({
      ok: true,
      maxSteps: 40,
      timeoutMs: 300_000,
      remaining: 40,
    });
  });

  it("累计已消耗 50：单次上限 = min(40, 剩余 30) = 30，预计剩余 0", () => {
    const r = childBudgetFor({ calls: 2, steps: 50 }, CFG);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.budget.maxSteps).toBe(30);
    expect(r.budget.timeoutMs).toBe(300_000);
    expect(r.budget.remaining).toBe(0);
  });

  it("累计恰好耗尽（80/80）：ok:false，不产生 budget", () => {
    const r = childBudgetFor({ calls: 2, steps: 80 }, CFG);
    expect(r.ok).toBe(false);
    expect(r.budget).toBeUndefined();
    expect(r.error).toContain("穿透执行预算耗尽");
  });

  it("累计超额（90/80）：ok:false，错误含回退建议", () => {
    const r = childBudgetFor({ calls: 3, steps: 90 }, CFG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("PTH_PENETRATION_TASK_BUDGET_STEPS");
    expect(r.error).toContain("改走 tasks.delegate 或收敛穿透调用");
  });

  it("单次上限非法为 0 时也不给 0 步（maxSteps 至少 1）", () => {
    const r = childBudgetFor(LEDGER_ZERO, { ...CFG, maxSteps: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.budget.maxSteps).toBe(1);
  });
});

describe("N15 B2 penetration-budget：recordPenetrationUse（按实际步数结算）", () => {
  it("结算按实际 steps 记账：calls+1、steps 累加", () => {
    const next = recordPenetrationUse({ calls: 1, steps: 30 }, 5);
    expect(next).toEqual({ calls: 2, steps: 35 });
  });

  it("失败也消耗预算：步数为 0 时仅 calls+1", () => {
    const next = recordPenetrationUse({ calls: 0, steps: 0 }, 0);
    expect(next).toEqual({ calls: 1, steps: 0 });
  });

  it("不修改原 ledger（纯函数）", () => {
    const ledger: PenetrationLedger = { calls: 1, steps: 10 };
    recordPenetrationUse(ledger, 7);
    expect(ledger).toEqual({ calls: 1, steps: 10 });
  });
});

describe("N15 B2 penetration-budget：penetrationBudgetError（文案契约）", () => {
  it("文案包含设计文档钉死的三个片段", () => {
    const msg = penetrationBudgetError(CFG, 80);
    expect(msg).toContain("穿透执行预算耗尽");
    expect(msg).toContain("PTH_PENETRATION_TASK_BUDGET_STEPS");
    expect(msg).toContain("改走 tasks.delegate 或收敛穿透调用");
  });

  it("文案包含已用步数与累计上限", () => {
    const msg = penetrationBudgetError(CFG, 90);
    expect(msg).toContain("90");
    expect(msg).toContain("80");
  });
});
