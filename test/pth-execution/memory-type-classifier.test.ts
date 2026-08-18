import { describe, expect, it } from "vitest";
import { classifyFeasibilityMemoryType } from "../../src/pth/execution/memory-type-classifier.js";
import type { MemoryRegion } from "../../src/pth/contracts/index.js";

describe("memory-type-classifier（四类投影边界）", () => {
  it("四类映射全部覆盖", () => {
    expect(classifyFeasibilityMemoryType({ kind: "domain-fact" })).toBe("wiki");
    expect(classifyFeasibilityMemoryType({ kind: "domain-method" })).toBe("wiki");
    expect(classifyFeasibilityMemoryType({ kind: "pth-wiki" })).toBe("wiki");
    expect(classifyFeasibilityMemoryType({ kind: "system-setting" })).toBe("setting");
    expect(classifyFeasibilityMemoryType({ kind: "role-definition" })).toBe("setting");
    expect(classifyFeasibilityMemoryType({ kind: "config" })).toBe("setting");
    expect(classifyFeasibilityMemoryType({ kind: "skill" })).toBe("skill");
    expect(classifyFeasibilityMemoryType({ kind: "skill-index" })).toBe("skill");
    expect(classifyFeasibilityMemoryType({ kind: "task-insight" })).toBe("log");
    expect(classifyFeasibilityMemoryType({ kind: "episodic-log" })).toBe("log");
  });

  it("未知 kind 返回 undefined（fail-closed 由 Directory 构建执行）", () => {
    expect(classifyFeasibilityMemoryType({ kind: "mystery-kind" })).toBeUndefined();
  });

  it("MemoryRegion.selector.memoryTypes 可查询四类", () => {
    const region: MemoryRegion = {
      regionId: "region:wiki",
      revision: 1,
      selector: { memoryTypes: ["wiki"] },
      estimatedWeight: 0,
    };
    expect(region.selector.memoryTypes).toEqual(["wiki"]);
  });
});
