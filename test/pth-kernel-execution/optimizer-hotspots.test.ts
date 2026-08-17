import { describe, it, expect } from "vitest";
import { detectHotspots, renderSuggestion } from "../../src/pth/kernel/execution/optimizer-hotspots.js";
import type { WorkerScorecard } from "../../src/pth/kernel/execution/worker-scorecard.js";

/** 构造 scorecard（指标级——避免 trace 组装；guard-kill-spike 测试用 guards 段） */
function sc(partial: Partial<WorkerScorecard> & { toolFreq?: Record<string, number> }): WorkerScorecard {
  return {
    steps: 10,
    toolFreq: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    failedActions: 0,
    gatedActions: 0,
    aspNav: { cds: 0, indexes: 0 },
    guards: { hits: {}, guide: {}, soft: {}, hard: {} },
    ...partial,
  };
}

describe("A4 护栏 JIT——guard-kill-spike 热点规则", () => {
  it("soft 族达标（kills≥5 且 killRatio>0.5）→ guard 建议", () => {
    const hits = detectHotspots([
      sc({ guards: { hits: { "negative-loop": 8 }, guide: { "negative-loop": 2 }, soft: { "negative-loop": 5 }, hard: {} } }),
    ]);
    const hit = hits.find((h) => h.pattern === "guard-kill-spike");
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("guard");
    expect(hit?.target).toBe("guard-config:negative-loop");
    expect(hit?.section).toBe("阈值");
    expect(hit?.guard).toEqual({ guard: "negative-loop", limitKey: "PTH_GUARD_NEGATIVE_LIMIT", scale: 1.5 });
    expect(hit?.metric).toMatchObject({ hits: 8, guide: 2, soft: 5, hard: 0, killRatio: 0.63, tasks: 1 });
  });

  it("数量不足不触发（kills<5 / killRatio≤0.5）", () => {
    const hits = detectHotspots([
      sc({ guards: { hits: { "negative-loop": 8 }, guide: {}, soft: { "negative-loop": 4 }, hard: {} } }),
    ]);
    expect(hits.find((h) => h.pattern === "guard-kill-spike")).toBeUndefined();
    // 其它规则也不误触（无失败/门控/导航/缓存信号）
    expect(hits).toEqual([]);
  });

  it("hard 契约护栏不触发（empty-done 硬终止再多也不自动建议放宽）", () => {
    const hits = detectHotspots([
      sc({ guards: { hits: { "empty-done": 4 }, guide: {}, soft: {}, hard: { "empty-done": 4 } } }),
    ]);
    expect(hits.find((h) => h.pattern === "guard-kill-spike")).toBeUndefined();
    expect(hits).toEqual([]);
  });

  it("多软护栏命中 → 选窗口内 kills 最多的护栏", () => {
    const hits = detectHotspots([
      sc({
        guards: {
          hits: { "negative-loop": 8, "repeat-action": 8 },
          guide: { "negative-loop": 1, "repeat-action": 1 },
          soft: { "negative-loop": 5, "repeat-action": 6 },
          hard: {},
        },
      }),
    ]);
    const hit = hits.find((h) => h.pattern === "guard-kill-spike");
    expect(hit?.target).toBe("guard-config:repeat-action");
    expect(hit?.guard?.guard).toBe("repeat-action");
    expect(hit?.guard?.limitKey).toBe("PTH_GUARD_REPEAT_LIMIT");
  });

  it("renderSuggestion guard 路径 → 建议参数 ×1.5 + 配置中心提示", () => {
    const text = renderSuggestion({
      pattern: "guard-kill-spike",
      path: "guard",
      target: "guard-config:negative-loop",
      section: "阈值",
      metric: { hits: 8, guide: 2, soft: 5, hard: 0, killRatio: 0.63, tasks: 1 },
      guard: { guard: "negative-loop", limitKey: "PTH_GUARD_NEGATIVE_LIMIT", scale: 1.5 },
    }, 10);
    expect(text).toContain("guard-kill-spike");
    expect(text).toContain("建议参数: PTH_GUARD_NEGATIVE_LIMIT ×1.5（当前值由批准时配置中心解析）");
    expect(text).toContain("写入目标: guard-config:negative-loop §阈值");
    expect(text).toContain("hits=8");
  });
});
