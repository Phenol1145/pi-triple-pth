import { describe, it, expect } from "vitest";
import { classifyLegacySuggestionKind } from "../../src/pth/execution/legacy-suggestion-migration.js";

describe("W4 存量 optimizer-suggestion 分类迁移", () => {
  it("含 modification-plan 结构字段 → modification-plan", () => {
    expect(classifyLegacySuggestionKind({ goal: "降失败率", changes: "调参", expected: "x", rollback: "r", retestWindow: "1h", implementation: { kind: "param-change" } })).toBe("modification-plan");
  });

  it("含观测语义且无方案结构 → observation-report", () => {
    expect(classifyLegacySuggestionKind({ observation: "调用点失败率 20%", severity: "high", evidence: "obs.callpoint" })).toBe("observation-report");
  });

  it("不确定 → 保留 optimizer-suggestion", () => {
    expect(classifyLegacySuggestionKind({ foo: "bar" })).toBe("optimizer-suggestion");
    expect(classifyLegacySuggestionKind("not-object")).toBe("optimizer-suggestion");
  });
});
