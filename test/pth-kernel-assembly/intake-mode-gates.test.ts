import { describe, expect, it } from "vitest";
import {
  assertIntakeFullAcceptance,
  selectIntakeStageHandlers,
} from "../../src/pth/bootstrap/intake-mode-gates.js";

const handlers = {
  "intake.fetch": async () => {},
  "intake.extract": async () => {},
  "intake.review-domain": async () => {},
  "intake.review-adversarial": async () => {},
  "intake.promote": async () => {},
};

describe("N29 refix P0-9：draft/full 模式分离", () => {
  it("off 模式零 handler", () => {
    expect(Object.keys(selectIntakeStageHandlers("off", handlers, "intake.promote"))).toHaveLength(0);
  });

  it("draft 模式剔除 promote handler（只到 private draft + open plan）", () => {
    const selected = selectIntakeStageHandlers("draft", handlers, "intake.promote");
    expect(Object.keys(selected).sort()).toEqual([
      "intake.extract", "intake.fetch", "intake.review-adversarial", "intake.review-domain",
    ]);
    expect(selected["intake.promote"]).toBeUndefined();
    // 原对象不被修改。
    expect(handlers["intake.promote"]).toBeDefined();
  });

  it("full 模式保留全部 handler", () => {
    expect(Object.keys(selectIntakeStageHandlers("full", handlers, "intake.promote")).sort())
      .toEqual(Object.keys(handlers).sort());
  });

  it("full 启动门：非 MIN_INNER_LOOP_GO / 缺 commit / 脏树 / commit 不符全部拒绝", () => {
    expect(() => assertIntakeFullAcceptance({ decision: "EVALUATION-INCOMPLETE", evaluatedCommit: "abc", implementationTreeClean: true }))
      .toThrow(/MIN_INNER_LOOP_GO/);
    expect(() => assertIntakeFullAcceptance({ decision: "NO-GO", evaluatedCommit: "abc", implementationTreeClean: true }))
      .toThrow(/MIN_INNER_LOOP_GO/);
    expect(() => assertIntakeFullAcceptance({ decision: "MIN_INNER_LOOP_GO" }))
      .toThrow(/evaluatedCommit/);
    expect(() => assertIntakeFullAcceptance({ decision: "MIN_INNER_LOOP_GO", evaluatedCommit: "abc", implementationTreeClean: false }))
      .toThrow(/implementationTreeClean/);
    expect(() => assertIntakeFullAcceptance(
      { decision: "MIN_INNER_LOOP_GO", evaluatedCommit: "abc", implementationTreeClean: true },
      "def",
    )).toThrow(/不一致/);
  });

  it("full 启动门：合法 envelope 通过", () => {
    expect(() => assertIntakeFullAcceptance(
      { decision: "MIN_INNER_LOOP_GO", evaluatedCommit: "abc", implementationTreeClean: true },
    )).not.toThrow();
    expect(() => assertIntakeFullAcceptance(
      { decision: "MIN_INNER_LOOP_GO", evaluatedCommit: "abc", implementationTreeClean: true },
      "abc",
    )).not.toThrow();
  });
});
