import { describe, it, expect } from "vitest";
import { attachActivityFactors, buildScorecard } from "@away_from/pth-kernel-execution";
import type { AgentTraceEvent } from "@away_from/pth-kernel-execution";

describe("WorkerScorecard TCE/ActivityFactor 消费", () => {
  it("tool-result duration 聚合到 toolDurationMs", () => {
    const events: AgentTraceEvent[] = [
      { type: "tool-result", step: 1, tool: "ts.run", ok: true, durationMs: 10, resultPreview: "ok" },
      { type: "tool-result", step: 2, tool: "ts.run", ok: true, durationMs: 20, resultPreview: "ok" },
      { type: "tool-result", step: 3, tool: "dev_read", ok: false, durationMs: 5, resultPreview: "x" },
    ];
    const sc = buildScorecard(events);
    expect(sc.toolDurationMs).toMatchObject({ "ts.run": 30, "dev_read": 5 });
    expect(sc.failedActions).toBe(1);
  });

  it("attachActivityFactors 把活动因子附加到 scorecard", () => {
    const sc = buildScorecard([]);
    const withFactors = attachActivityFactors(sc, [
      { strategyId: "obs:fail-rate", value: 0.3 },
      { strategyId: "obs:read-ratio", value: 0.7 },
    ]);
    expect(withFactors.activityFactors).toEqual({ "obs:fail-rate": 0.3, "obs:read-ratio": 0.7 });
  });
});
