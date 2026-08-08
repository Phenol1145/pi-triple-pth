import { describe, it, expect } from "vitest";
import { decideScale } from "../../src/pth/kernel/execution/batch-scaler.js";

describe("batch 自动扩缩容决策（纯函数）", () => {
  const base = { pendingCount: 0, idleRatio: 1, batchCount: 1, min: 1, max: 4, upThreshold: 5 };

  it("pending 积压超阈值且未达 max → scale-up", () => {
    const r = decideScale({ ...base, pendingCount: 6 });
    expect(r.action).toBe("scale-up");
  });

  it("pending 未超阈值 → keep", () => {
    const r = decideScale({ ...base, pendingCount: 4 });
    expect(r.action).toBe("keep");
  });

  it("已达 max 即使积压也 keep（上限保护）", () => {
    const r = decideScale({ ...base, pendingCount: 20, batchCount: 4 });
    expect(r.action).toBe("keep");
    expect(r.reason).toContain("上限");
  });

  it("全部 idle + pending 空 + 超过 min → scale-down", () => {
    const r = decideScale({ ...base, batchCount: 3, idleRatio: 1 });
    expect(r.action).toBe("scale-down");
  });

  it("batch = min 时不缩容（下限保护）", () => {
    const r = decideScale({ ...base, batchCount: 1 });
    expect(r.action).toBe("keep");
    expect(r.reason).toContain("下限");
  });

  it("有任务在跑（idleRatio < 1）即使 pending 空也不缩（防误杀）", () => {
    const r = decideScale({ ...base, batchCount: 3, idleRatio: 0.7 });
    expect(r.action).toBe("keep");
  });

  it("pending 空但 batch > min 且有 batch 忙 → keep（不是全 idle）", () => {
    const r = decideScale({ ...base, batchCount: 3, idleRatio: 0.9 });
    expect(r.action).toBe("keep");
  });

  it("scale-up 时 batch 数 < max 且空闲批可用优先复用（reason 记录）", () => {
    const r = decideScale({ ...base, pendingCount: 8, batchCount: 2, idleRatio: 0.5 });
    expect(r.action).toBe("scale-up");
  });
});
