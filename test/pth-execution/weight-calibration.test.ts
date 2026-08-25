import { describe, it, expect } from "vitest";
import { calibrateWeight } from "../../src/pth/execution/weight-calibration.js";

describe("N28 权重标定", () => {
  it("高命中 → 高权重建议", () => {
    const s = calibrateWeight({ regionId: "r1", hits: 80, misses: 20 });
    expect(s.suggestedWeight).toBe(80);
    expect(s.hitRate).toBe(0.8);
  });

  it("零样本 → 0 权重建议", () => {
    const s = calibrateWeight({ regionId: "r2", hits: 0, misses: 0 });
    expect(s.suggestedWeight).toBe(0);
  });
});
