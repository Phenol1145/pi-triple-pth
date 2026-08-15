import { describe, it, expect } from "vitest";
import { reconstructThinkingPath } from "../../src/pth/kernel/execution/thinking-path.js";
import { buildScorecard } from "../../src/pth/kernel/execution/worker-scorecard.js";
import type { AgentTraceEvent } from "../../src/pth/kernel/execution/agent-loop.js";

const events: AgentTraceEvent[] = [
  { type: "llm-call", step: 1, contentPreview: "先查记忆" },
  { type: "tool-call", step: 1, tool: "memory.query", args: { sql: "SELECT 1" } },
  { type: "tool-result", step: 1, tool: "memory.query", ok: true, durationMs: 10, resultPreview: "发现 X" },
  { type: "llm-call", step: 2, contentPreview: "读源码" },
  { type: "tool-call", step: 2, tool: "fs.readSource", args: { rel: "a.ts" } },
  { type: "tool-result", step: 2, tool: "fs.readSource", ok: true, durationMs: 10, resultPreview: "源码 Y" },
  // 重复探测：再次读同一结果
  { type: "tool-call", step: 3, tool: "fs.readSource", args: { rel: "a.ts" } },
  { type: "tool-result", step: 3, tool: "fs.readSource", ok: true, durationMs: 8, resultPreview: "源码 Y" },
  // 盲试：无新发现直接动作
  { type: "tool-call", step: 4, tool: "dev.write", args: { path: "out.ts" } },
  { type: "tool-result", step: 4, tool: "dev.write", ok: true, durationMs: 5, resultPreview: "已写 out.ts" },
  // 工具缺口 + 记忆缺口
  { type: "tool-call", step: 5, tool: "nonexistent", args: {} },
  { type: "tool-result", step: 5, tool: "nonexistent", ok: false, durationMs: 0, resultPreview: "未知工具引导 nonexistent" },
  { type: "tool-call", step: 6, tool: "memory.retrieve", args: { anchors: ["x"] } },
  { type: "tool-result", step: 6, tool: "memory.retrieve", ok: false, durationMs: 2, resultPreview: "查询失败" },
  { type: "finish", ok: true, steps: 6 },
];

describe("思考路径图重建器（E1 / N13）", () => {
  it("发现链去重 + 决策链对位 + 意图链分段", () => {
    const path = reconstructThinkingPath(events);
    expect(path.discoveries.map((d) => d.tool)).toEqual(["memory.query", "fs.readSource", "dev.write"]);
    expect(path.decisions).toHaveLength(6);
    expect(path.decisions[0]!.discoveryIndex).toBeNull();       // 首步查询尚无发现 = 盲试
    expect(path.decisions[1]!.discoveryIndex).toBe(0);          // 读源码依赖 memory 发现
    expect(path.intents.map((i) => i.phase)).toEqual(["explore", "implement", "other", "explore"]);
  });

  it("岔路口：重复探测与盲试", () => {
    const path = reconstructThinkingPath(events);
    expect(path.forks.repeatedProbes).toHaveLength(1);
    expect(path.forks.repeatedProbes[0]).toMatchObject({ tool: "fs.readSource" });
    expect(path.forks.blindAttempts.some((b) => b.tool === "memory.query")).toBe(true);
  });

  it("缺口：工具缺口（未知工具）与记忆缺口（检索失败）", () => {
    const path = reconstructThinkingPath(events);
    expect(path.gaps.toolGaps).toHaveLength(1);
    expect(path.gaps.memoryGaps).toHaveLength(1);
  });
});

describe("D1：护栏进 scorecard", () => {
  it("guard 事件聚合 hits/soft/hard", () => {
    const withGuards: AgentTraceEvent[] = [
      ...events,
      { type: "guard", step: 2, guard: "repeat-action", kind: "guide", count: 3, limit: 5 },
      { type: "guard", step: 3, guard: "repeat-action", kind: "soft", count: 5, limit: 5 },
      { type: "guard", step: 5, guard: "unknown-tool", kind: "hard", count: 3, limit: 3 },
    ];
    const sc = buildScorecard(withGuards);
    expect(sc.guards.hits["repeat-action"]).toBe(2);
    expect(sc.guards.guide["repeat-action"]).toBe(1);
    expect(sc.guards.soft["repeat-action"]).toBe(1);
    expect(sc.guards.hard["unknown-tool"]).toBe(1);
  });
});
