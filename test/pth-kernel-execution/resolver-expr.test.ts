import { describe, it, expect } from "vitest";
import { evalCondition } from "@away_from/pth-kernel-execution";

describe("evalCondition（条件表达式）", () => {
  const ctx = {
    output: { ok: true, score: 0.85, count: 3 },
    loopCount: 2,
    claimsCount: 1,
  };

  it("基础比较：== != < > <=", () => {
    expect(evalCondition("output.ok == true", ctx)).toBe(true);
    expect(evalCondition("output.ok != true", ctx)).toBe(false);
    expect(evalCondition("output.score >= 0.8", ctx)).toBe(true);
    expect(evalCondition("output.score < 0.5", ctx)).toBe(false);
    expect(evalCondition("loopCount <= 3", ctx)).toBe(true);
  });

  it("&& 平级", () => {
    expect(evalCondition("output.ok == true && loopCount < 3", ctx)).toBe(true);
    expect(evalCondition("output.ok == true && loopCount > 3", ctx)).toBe(false);
  });

  it("|| 嵌套", () => {
    expect(evalCondition("output.ok == true || loopCount > 10", ctx)).toBe(true);
    expect(evalCondition("output.ok == false || loopCount > 10", ctx)).toBe(false);
  });

  it("! 取反", () => {
    expect(evalCondition("!output.ok", ctx)).toBe(false);
    expect(evalCondition("!(loopCount > 5)", ctx)).toBe(true);
  });

  it("括号分组", () => {
    expect(evalCondition("(output.ok == true && output.score >= 0.8) || loopCount > 10", ctx)).toBe(true);
    expect(evalCondition("(output.ok == false && output.score >= 0.8) || loopCount > 10", ctx)).toBe(false);
  });

  it("字符串字面量", () => {
    expect(evalCondition('output.status == "completed"', { ...ctx, output: { ...ctx.output, status: "completed" } })).toBe(true);
  });

  it("数字字面量（int/float）", () => {
    expect(evalCondition("output.count == 3", ctx)).toBe(true);
    expect(evalCondition("output.count == 3.0", ctx)).toBe(true);
  });

  it("非法表达式 → false（不抛）", () => {
    expect(evalCondition("not a valid expr", ctx)).toBe(false);
    expect(evalCondition("", ctx)).toBe(false);
  });
});
