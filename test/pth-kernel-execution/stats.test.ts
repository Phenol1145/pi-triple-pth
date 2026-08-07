import { describe, it, expect } from "vitest";
import { collectStats, suggest } from "../../src/pth/kernel/execution/stats";

describe("load stats", () => {
  it("collectStats reads pending count and idle ratio", async () => {
    const taskStore = { countPending: async () => 15 } as any;
    const batches = [
      { id: "b1", workers: ["a", "d"], currentTasks: { d: "t1" } },   // 1/2 忙
      { id: "b2", workers: ["a", "d"], currentTasks: {} },            // 0/2 忙
    ] as any;
    const stats = await collectStats({ taskStore, batches });
    expect(stats.pendingCount).toBe(15);
    expect(stats.batchCount).toBe(2);
    expect(stats.idleRatio).toBeCloseTo(0.75);   // 3/4 空闲
  });

  it("suggest add when pending high and workers busy", () => {
    const s = suggest({ pendingCount: 20, idleRatio: 0.2, batchCount: 1, collectedAt: 0 });
    expect(s.action).toBe("add");
  });

  it("suggest remove when idle and multiple batches", () => {
    const s = suggest({ pendingCount: 1, idleRatio: 0.8, batchCount: 3, collectedAt: 0 });
    expect(s.action).toBe("remove");
  });

  it("suggest keep otherwise", () => {
    const s = suggest({ pendingCount: 5, idleRatio: 0.5, batchCount: 2, collectedAt: 0 });
    expect(s.action).toBe("keep");
  });
});
