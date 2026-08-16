import { describe, it, expect } from "vitest";
import { roleAnchorOf, hasRoleAnchor, filterOwnEntries, filterOwnRows, requireAnchorRows } from "../../src/pth/kernel/execution/memory-scope.js";

describe("memoryScope=own 角色域过滤（模块优化 ⑤）", () => {
  it("role anchor 与条目过滤", () => {
    expect(roleAnchorOf("developer")).toBe("role:developer");
    expect(hasRoleAnchor("developer", { anchors: ["role:developer", "x"] })).toBe(true);
    expect(hasRoleAnchor("developer", { anchors: ["role:planner"] })).toBe(false);
    expect(filterOwnEntries("developer", [
      { anchors: ["role:developer"] },
      { anchors: ["other"] },
      { anchors: undefined },
    ])).toHaveLength(1);
  });

  it("query 行必须投影 anchors（fail-closed）", () => {
    expect(() => requireAnchorRows([{ id: "x" }])).toThrow(/anchors 列/);
    const rows = requireAnchorRows([{ id: "x", anchors: ["role:developer"] }]);
    expect(filterOwnRows("developer", rows)).toHaveLength(1);
    expect(filterOwnRows("planner", rows)).toHaveLength(0);
  });
});
