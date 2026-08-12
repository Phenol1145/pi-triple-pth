import { describe, it, expect, vi } from "vitest";
import { Optimizer, detectHotspots, renderSuggestion, READ_TOOLS } from "../../src/pth/kernel/execution/optimizer-loop.js";
import { buildScorecard } from "../../src/pth/kernel/execution/worker-scorecard.js";
import type { WorkerScorecard } from "../../src/pth/kernel/execution/worker-scorecard.js";

/** 构造 scorecard（指标级——避免 trace 组装） */
function sc(partial: Partial<WorkerScorecard> & { toolFreq?: Record<string, number> }): WorkerScorecard {
  return {
    steps: 10, toolFreq: {}, tokens: { input: 0, output: 0 }, failedActions: 0, gatedActions: 0,
    aspNav: { cds: 0, indexes: 0 },
    ...partial,
  };
}

describe("Optimizer 环（2026-08-12 大项）——热点检测规则", () => {
  it("gate-heavy：门控占比 >30% 且 ≥5 次 → 规则建议（capability-index 补导航规则）", () => {
    const hits = detectHotspots([sc({ steps: 12, gatedActions: 5 }), sc({ steps: 8, gatedActions: 4 })]);
    const gate = hits.find((h) => h.pattern === "gate-heavy");
    expect(gate).toBeDefined();
    expect(gate?.path).toBe("rule");
    expect(gate?.target).toBe("capability-index");
    expect(gate?.metric.ratio).toBe(0.45);   // 9/20
  });

  it("gate-heavy 未达阈值不触发（门控少/占比低）", () => {
    expect(detectHotspots([sc({ steps: 20, gatedActions: 2 }), sc({ steps: 30, gatedActions: 3 })])).toEqual([]);
  });

  it("repeated-fail：窗口失败率 >15% → 工具用法规则建议（高频工具为目标）", () => {
    const hits = detectHotspots([
      sc({ steps: 10, failedActions: 2, toolFreq: { dev_write: 8, dev_read: 2 } }),
      sc({ steps: 10, failedActions: 2, toolFreq: { dev_write: 6 } }),
    ]);
    const rf = hits.find((h) => h.pattern === "repeated-fail");
    expect(rf).toBeDefined();
    expect(rf?.target).toBe("tool-function:dev_write");
    expect(rf?.metric.failRate).toBeGreaterThan(0.15);
  });

  it("fragmented-read：读族占比 ≥40% 且 ≥6 次（roadmap 实证反模式）", () => {
    const hits = detectHotspots([sc({ toolFreq: { dev_read: 3, fs_read: 2, asp_index: 1, dev_write: 5 } })]);
    const fr = hits.find((h) => h.pattern === "fragmented-read");
    expect(fr).toBeDefined();
    expect(fr?.metric.readCalls).toBe(6);
    expect(fr?.metric.ratio).toBeCloseTo(0.545, 1);
    expect(READ_TOOLS).toContain("dev_read");
  });

  it("nav-heavy：asp_cd ≥4 → 导航规划建议", () => {
    const hits = detectHotspots([sc({ aspNav: { cds: 3, indexes: 0 } }), sc({ aspNav: { cds: 2, indexes: 1 } })]);
    expect(hits.find((h) => h.pattern === "nav-heavy")).toBeDefined();
  });

  it("no-progress：失败任务 + 高步数 → 路径 B（角色分化）", () => {
    const hits = detectHotspots([
      sc({ steps: 40, finish: { ok: false } }),
      sc({ steps: 5, finish: { ok: true } }),
    ]);
    const np = hits.find((h) => h.pattern === "no-progress");
    expect(np).toBeDefined();
    expect(np?.path).toBe("role");
    expect(np?.target).toBe("lineage:executor");
  });

  it("空窗口 → 无命中", () => {
    expect(detectHotspots([])).toEqual([]);
  });
});

describe("Optimizer 环——建议生成（模板化）", () => {
  it("渲染含反模式描述/证据/建议规则/写入目标", () => {
    const text = renderSuggestion({ pattern: "fragmented-read", path: "rule", target: "capability-index", section: "## 读取策略", metric: { readCalls: 6, ratio: 0.5 } }, 10);
    expect(text).toContain("fragmented-read");
    expect(text).toContain("一次拉全");
    expect(text).toContain("capability-index §## 读取策略");
    expect(text).toContain("readCalls=6");
  });

  it("gate-heavy 模板含导航规则", () => {
    const text = renderSuggestion({ pattern: "gate-heavy", path: "rule", target: "capability-index", section: "## 空间协议", metric: { ratio: 0.45 } }, 10);
    expect(text).toContain("asp.index 确认当前空间工具面");
  });
});

describe("Optimizer 环——窗口流转", () => {
  it("窗口满触发检测 → 建议落库（draft）+ 事件钩子", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const suggestions: string[] = [];
    const opt = new Optimizer({
      windowSize: 2,
      memory: { write: async (e) => { writes.push(e); return { ok: true }; } },
      onSuggestion: (s) => suggestions.push(s.id),
    });
    // 两个 gate-heavy 任务（窗口 2 满 → 检测）
    opt.collect(sc({ steps: 10, gatedActions: 5 }), { role: "executor", taskId: "t1" });
    expect(writes.length).toBe(1);   // scorecard 已落
    opt.collect(sc({ steps: 10, gatedActions: 4 }), { role: "executor", taskId: "t2" });
    // 建议落库（draft）+ 事件
    const sugg = writes.filter((w) => w.kind === "optimizer-suggestion");
    expect(sugg.length).toBeGreaterThanOrEqual(1);
    expect(sugg[0]?.status).toBe("draft");
    expect((sugg[0]?.content as { evidence: { pattern: string } }).evidence.pattern).toBe("gate-heavy");
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(opt.pending().length).toBeGreaterThanOrEqual(1);
  });

  it("无命中窗口 → 只落 scorecard 不落建议", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const opt = new Optimizer({ windowSize: 2, memory: { write: async (e) => { writes.push(e); return { ok: true }; } } });
    opt.collect(sc({ steps: 4, gatedActions: 0, toolFreq: { dev_write: 1 } }), { role: "executor", taskId: "t1" });
    opt.collect(sc({ steps: 3, gatedActions: 0, toolFreq: { dev_write: 1 } }), { role: "executor", taskId: "t2" });
    expect(writes.filter((w) => w.kind === "optimizer-suggestion")).toEqual([]);
    expect(writes.filter((w) => w.kind === "task-scorecard")).toHaveLength(2);
  });

  it("scorecard 构建（trace 级——buildScorecard 兼容）", () => {
    const scCard = buildScorecard([
      { type: "tool-call", step: 1, tool: "asp_cd", args: {} } as never,
      { type: "tool-call", step: 2, tool: "dev_read", args: {} } as never,
      { type: "tool-result", step: 2, tool: "dev_read", ok: false, durationMs: 1, resultPreview: "" } as never,
      { type: "finish", step: 3, ok: true } as never,
    ]);
    expect(scCard.toolFreq.asp_cd).toBe(1);
    expect(scCard.failedActions).toBe(1);
  });
});

describe("Optimizer 环——振荡防护（待决点 4：死区 + 应用上限）", () => {
  function navHeavySc(): WorkerScorecard {
    return {
      steps: 10, gatedActions: 0, failedActions: 0,
      toolFreq: { asp_cd: 5 },
      aspNav: { cds: 5, depth: 3 },
      finish: { ok: true },
      tokens: { input: 1000, output: 100 },
    } as WorkerScorecard;
  }

  it("死区：同 pattern 在 deadbandWindows 窗口内不重复建议（第 2-3 窗口跳过——第 4 窗口恢复）", () => {
    const seen: string[] = [];
    const opt = new Optimizer({ windowSize: 2, deadbandWindows: 2, onSuggestion: (s) => seen.push(s.evidence.pattern) });
    // 窗口 1：建议 nav-heavy
    opt.collect(navHeavySc(), { role: "developer", taskId: "a" });
    opt.collect(navHeavySc(), { role: "developer", taskId: "b" });
    expect(seen).toEqual(["nav-heavy"]);
    // 窗口 2（死区内）：同 pattern 跳过
    opt.collect(navHeavySc(), { role: "developer", taskId: "c" });
    opt.collect(navHeavySc(), { role: "developer", taskId: "d" });
    expect(seen).toEqual(["nav-heavy"]);
    // 窗口 3（死区内）：仍跳过
    opt.collect(navHeavySc(), { role: "developer", taskId: "e" });
    opt.collect(navHeavySc(), { role: "developer", taskId: "f" });
    expect(seen).toEqual(["nav-heavy"]);
    // 窗口 4（死区外）：恢复建议
    opt.collect(navHeavySc(), { role: "developer", taskId: "g" });
    opt.collect(navHeavySc(), { role: "developer", taskId: "h" });
    expect(seen).toEqual(["nav-heavy", "nav-heavy"]);
  });

  it("死区可配置 0（关闭）——每窗口都建议", () => {
    const seen: string[] = [];
    const opt = new Optimizer({ windowSize: 2, deadbandWindows: 0, onSuggestion: (s) => seen.push(s.evidence.pattern) });
    opt.collect(navHeavySc(), { role: "developer", taskId: "a" });
    opt.collect(navHeavySc(), { role: "developer", taskId: "b" });
    opt.collect(navHeavySc(), { role: "developer", taskId: "c" });
    opt.collect(navHeavySc(), { role: "developer", taskId: "d" });
    expect(seen).toEqual(["nav-heavy", "nav-heavy"]);
  });
});
