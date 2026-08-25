import { describe, it, expect } from "vitest";
import { planRebalance } from "../../src/pth/execution/rebalance-planner.js";

describe("N28 重平衡规划", () => {
  it("超重区域产生 move 到最轻区域", () => {
    const moves = planRebalance(
      [{ id: "a", weight: 90 }, { id: "b", weight: 10 }],
      { a: ["e1", "e2"], b: [] },
      80,
    );
    expect(moves.length).toBeGreaterThan(0);
    expect(moves[0]!.fromRegionId).toBe("a");
    expect(moves[0]!.toRegionId).toBe("b");
  });

  it("全部未超重 → 无 move", () => {
    const moves = planRebalance(
      [{ id: "a", weight: 50 }, { id: "b", weight: 40 }],
      { a: ["e1"], b: [] },
      80,
    );
    expect(moves).toEqual([]);
  });
});
