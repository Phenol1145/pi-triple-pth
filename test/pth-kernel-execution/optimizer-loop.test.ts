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

describe("scorecard 聚合快照（2026-08-12 审批面 B 实施）", () => {
  it("collect 同步 upsert 聚合（读-改-写——两任务累积）", async () => {
    const { Optimizer } = await import("../../src/pth/kernel/execution/optimizer-loop.js");
    const entries: Array<Record<string, unknown>> = [];
    const aggs = new Map<string, Record<string, number>>();
    const memory = {
      write: async (e: Record<string, unknown>) => { entries.push(e); },
      incrementAggregate: async (id: string, _kind: string, _anchors: unknown[], deltas: Record<string, number>) => {
        const cur = aggs.get(id) ?? {};
        const next: Record<string, number> = {};
        for (const [k, v] of Object.entries(deltas)) next[k] = (cur[k] ?? 0) + v;
        aggs.set(id, next);
      },
    };
    const opt = new Optimizer({ memory: memory as never });
    opt.collect({ steps: 10, toolFreq: {}, tokens: { input: 1000, output: 100, cacheRead: 600, cacheWrite: 200 }, failedActions: 1, gatedActions: 0, aspNav: { cds: 1, indexes: 0 }, finish: { ok: true } } as never, { role: "tester", taskId: "t1" });
    opt.collect({ steps: 20, toolFreq: {}, tokens: { input: 2000, output: 200, cacheRead: 1400, cacheWrite: 0 }, failedActions: 2, gatedActions: 1, aspNav: { cds: 2, indexes: 0 }, finish: { ok: true } } as never, { role: "tester", taskId: "t2" });
    // 聚合是 fire-and-forget（void async）——等微任务队列排空
    await new Promise((r) => setTimeout(r, 10));
    const c = aggs.get("task-scorecard-aggregate:tester") ?? {};
    expect(c.taskCount).toBe(2);
    expect(c.sumSteps).toBe(30);
    expect(c.sumTokIn).toBe(3000);
    expect(c.sumCacheRead).toBe(2000);
    expect(c.sumFails).toBe(3);
    // scorecard 明细也在（2 条）
    expect(entries.filter((e) => e.kind === "task-scorecard").length).toBe(2);
  });
});

describe("deopt 回滚（2026-08-13 稳定循环刹车）", () => {
  it("指标劣化 → 移除规则 stamp + rolled_back；未劣化 → 移除基线不再复测", async () => {
    const { Optimizer } = await import("../../src/pth/kernel/execution/optimizer-loop.js");
    // 假 store：聚合/建议/文档 + update 记录
    const agg = { taskCount: 12, sumFails: 24, sumSteps: 60 };   // 当前（基线后 +2 任务——窗口 2）
    const docs = new Map<string, string>([
      ["role-doc:dev", "前文\n\n【优化规则 · test-pattern（2026-08-13 批准）】\n- 规则行\n后文"],
    ]);
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const mem = {
      write: async () => {},
      queryReadOnly: async (sql: string) => {
        if (sql.includes("optimizer-suggestion")) {
          return [{ id: "sug-1", content: JSON.stringify({ target: "role-doc:dev", evidence: { pattern: "test-pattern" } }),
            meta: { baseline: { avgFails: 1, avgSteps: 4, taskCount: 10 } } }];
        }
        if (sql.includes("task-scorecard-aggregate:dev")) return [{ content: JSON.stringify(agg) }];
        if (sql.includes("role-doc:dev")) return [{ content: docs.get("role-doc:dev") }];
        return [];
      },
      update: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); },
    };
    const opt = new Optimizer({ memory: mem as never, windowSize: 2, deadbandWindows: 0 });
    // 触发 detect（内部调 checkDeopt）
    const baseSc = { steps: 3, toolFreq: {}, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, failedActions: 0, gatedActions: 0, aspNav: { cds: 0, indexes: 0 }, finish: { ok: true } };
    opt.collect(baseSc as never, { role: "dev", taskId: "t1" });
    opt.collect(baseSc as never, { role: "dev", taskId: "t2" });
    await new Promise((r) => setTimeout(r, 10));   // 等异步 checkDeopt
    // 劣化判定：avgFails 1→2（+100%）→ 回滚
    const rollback = updates.find((u) => u.id === "sug-1");
    expect(rollback?.patch.status).toBe("rolled_back");
    expect(rollback?.patch.meta?.["rolledBack"]).toBe(true);
  });
});


describe("复测一等化（2026-08-14 N6——独立复测任务/超时闭合/全局聚合）", () => {
  it("collect verifyOf → 只进 verify-aggregate（不进热点窗口/角色聚合）", async () => {
    const { Optimizer } = await import("../../src/pth/kernel/execution/optimizer-loop.js");
    const aggs = new Map<string, Record<string, number>>();
    const writes: Array<Record<string, unknown>> = [];
    const memory = {
      write: async (e: Record<string, unknown>) => { writes.push(e); },
      incrementAggregate: async (id: string, _kind: string, _anchors: unknown[], deltas: Record<string, number>) => {
        const cur = aggs.get(id) ?? {};
        const next: Record<string, number> = {};
        for (const [k, v] of Object.entries(deltas)) next[k] = (cur[k] ?? 0) + v;
        aggs.set(id, next);
      },
    };
    const opt = new Optimizer({ memory: memory as never, windowSize: 2, deadbandWindows: 0, verifySweepMs: 0 });
    const sc = { steps: 7, toolFreq: {}, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, failedActions: 2, gatedActions: 0, aspNav: { cds: 1, indexes: 0 }, finish: { ok: true } };
    opt.collect(sc as never, { role: "developer", taskId: "v1", verifyOf: "sug-v" });
    await new Promise((r) => setTimeout(r, 10));
    const vAgg = aggs.get("verify-aggregate:sug-v") ?? {};
    expect(vAgg.taskCount).toBe(1);
    expect(vAgg.sumFails).toBe(2);
    expect(vAgg.sumSteps).toBe(7);
    expect(aggs.get("task-scorecard-aggregate:developer")).toBeUndefined();   // 角色聚合不受污染
    expect(writes.filter((e) => e.kind === "task-scorecard").length).toBe(0);   // 明细也不落（受控证据独立通道）
  });

  it("checkDeopt：复测任务证据成熟 → 劣化回滚（verify-task 通道优先于有机流量）", async () => {
    const { Optimizer } = await import("../../src/pth/kernel/execution/optimizer-loop.js");
    const docs = new Map<string, string>([
      ["role-doc:dev", "前文\n\n【优化规则 · v-pattern（2026-08-14 批准）】\n- 规则行\n后文"],
    ]);
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const mem = {
      write: async () => {},
      queryReadOnly: async (sql: string) => {
        if (sql.includes("optimizer-suggestion")) {
          return [{ id: "sug-v", content: JSON.stringify({ target: "role-doc:dev", evidence: { pattern: "v-pattern" } }),
            meta: { baseline: { avgFails: 1, avgSteps: 4, taskCount: 10 }, appliedAt: Date.now() } }];
        }
        // 复测聚合：3 个受控任务——avgFails 3（劣化 200%）——受控证据优先结算
        if (sql.includes("verify-aggregate:sug-v")) return [{ content: JSON.stringify({ taskCount: 3, sumFails: 9, sumSteps: 12 }) }];
        if (sql.includes("role-doc:dev")) return [{ content: docs.get("role-doc:dev") }];
        return [];
      },
      update: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); },
    };
    const opt = new Optimizer({ memory: mem as never, windowSize: 2, deadbandWindows: 0, verifyTasksCount: 3, verifySweepMs: 0 });
    const baseSc = { steps: 3, toolFreq: {}, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, failedActions: 0, gatedActions: 0, aspNav: { cds: 0, indexes: 0 }, finish: { ok: true } };
    opt.collect(baseSc as never, { role: "dev", taskId: "t1" });
    opt.collect(baseSc as never, { role: "dev", taskId: "t2" });
    await new Promise((r) => setTimeout(r, 10));
    const rollback = updates.find((u) => u.id === "sug-v");
    expect(rollback?.patch.status).toBe("rolled_back");
    expect(rollback?.patch.meta?.["verifySource"]).toBe("verify-task");
  });

  it("checkDeopt：复测任务证据达标 → verified（不劣化——验证闭合）", async () => {
    const { Optimizer } = await import("../../src/pth/kernel/execution/optimizer-loop.js");
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const mem = {
      write: async () => {},
      queryReadOnly: async (sql: string) => {
        if (sql.includes("optimizer-suggestion")) {
          return [{ id: "sug-ok", content: JSON.stringify({ target: "role-doc:dev", evidence: { pattern: "ok-pattern" } }),
            meta: { baseline: { avgFails: 1, avgSteps: 4, taskCount: 10 }, appliedAt: Date.now() } }];
        }
        // 复测聚合：3 个受控任务——avgFails 0.33（改善）——verified
        if (sql.includes("verify-aggregate:sug-ok")) return [{ content: JSON.stringify({ taskCount: 3, sumFails: 1, sumSteps: 9 }) }];
        return [];
      },
      update: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); },
    };
    const opt = new Optimizer({ memory: mem as never, windowSize: 2, deadbandWindows: 0, verifyTasksCount: 3, verifySweepMs: 0 });
    const baseSc = { steps: 3, toolFreq: {}, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, failedActions: 0, gatedActions: 0, aspNav: { cds: 0, indexes: 0 }, finish: { ok: true } };
    opt.collect(baseSc as never, { role: "dev", taskId: "t1" });
    opt.collect(baseSc as never, { role: "dev", taskId: "t2" });
    await new Promise((r) => setTimeout(r, 10));
    const verified = updates.find((u) => u.id === "sug-ok");
    expect(verified?.patch.meta?.["verifyAfterWindow"]).toBe(false);
    expect(verified?.patch.meta?.["verifiedAt"]).toBeDefined();
    expect(verified?.patch.meta?.["verifySource"]).toBe("verify-task");
  });

  it("checkDeopt：超时零进展 → verify_expired + 洞察（诚实缺口可见）", async () => {
    const { Optimizer } = await import("../../src/pth/kernel/execution/optimizer-loop.js");
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const writes: Array<Record<string, unknown>> = [];
    const mem = {
      write: async (e: Record<string, unknown>) => { writes.push(e); },
      queryReadOnly: async (sql: string) => {
        if (sql.includes("optimizer-suggestion")) {
          return [{ id: "sug-stall", content: JSON.stringify({ target: "role-doc:dev", evidence: { pattern: "stall-pattern" } }),
            meta: { baseline: { avgFails: 1, avgSteps: 4, taskCount: 10 }, appliedAt: Date.now() - 40 * 60_000 } }];   // 40min 前——超 30min 超时
        }
        return [];
      },
      update: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); },
    };
    const opt = new Optimizer({ memory: mem as never, windowSize: 2, deadbandWindows: 0, verifyTimeoutMs: 30 * 60_000, verifySweepMs: 0 });
    const baseSc = { steps: 3, toolFreq: {}, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, failedActions: 0, gatedActions: 0, aspNav: { cds: 0, indexes: 0 }, finish: { ok: true } };
    opt.collect(baseSc as never, { role: "dev", taskId: "t1" });
    opt.collect(baseSc as never, { role: "dev", taskId: "t2" });
    await new Promise((r) => setTimeout(r, 10));
    const expired = updates.find((u) => u.id === "sug-stall");
    expect(expired?.patch.meta?.["verifyExpired"]).toBe(true);
    expect(expired?.patch.meta?.["verifyAfterWindow"]).toBe(false);
    expect(writes.some((w) => w.kind === "task-insight" && JSON.stringify(w.content).includes("verify-expired"))).toBe(true);
  });

  it("checkDeopt：capability-index 目标走全局聚合（rollup 跨角色）", async () => {
    const { Optimizer, rollupAggregateRows } = await import("../../src/pth/kernel/execution/optimizer-loop.js");
    // rollup 助手单测
    expect(rollupAggregateRows([{ content: JSON.stringify({ taskCount: 5, sumFails: 10, sumSteps: 20 }) }, { content: JSON.stringify({ taskCount: 3, sumFails: 2, sumSteps: 12 }) }])).toEqual({ taskCount: 8, sumFails: 12, sumSteps: 32, sumGuardHits: 0, sumGuardSoft: 0, sumGuardHard: 0, sumGuardKills: 0 });
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const mem = {
      write: async () => {},
      queryReadOnly: async (sql: string) => {
        if (sql.includes("optimizer-suggestion")) {
          return [{ id: "sug-global", content: JSON.stringify({ target: "capability-index", evidence: { pattern: "g-pattern" } }),
            meta: { baseline: { avgFails: 1, avgSteps: 4, taskCount: 10 }, appliedAt: Date.now() } }];
        }
        // 全局聚合：taskCount 13（基线 10 后 +3 ≥ 窗口 2）——avgFails 26/13=2（+100% 劣化）
        if (sql.includes("kind = 'task-scorecard-aggregate'")) {
          return [
            { content: JSON.stringify({ taskCount: 7, sumFails: 14, sumSteps: 28 }) },
            { content: JSON.stringify({ taskCount: 6, sumFails: 12, sumSteps: 24 }) },
          ];
        }
        if (sql.includes("id = 'capability-index'")) return [{ content: "前文\n\n【优化规则 · g-pattern（2026-08-14 批准）】\n- 规则行\n后文" }];
        return [];
      },
      update: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); },
    };
    const opt = new Optimizer({ memory: mem as never, windowSize: 2, deadbandWindows: 0, verifySweepMs: 0 });
    const baseSc = { steps: 3, toolFreq: {}, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, failedActions: 0, gatedActions: 0, aspNav: { cds: 0, indexes: 0 }, finish: { ok: true } };
    opt.collect(baseSc as never, { role: "dev", taskId: "t1" });
    opt.collect(baseSc as never, { role: "dev", taskId: "t2" });
    await new Promise((r) => setTimeout(r, 10));
    const rollback = updates.find((u) => u.id === "sug-global");
    expect(rollback?.patch.status).toBe("rolled_back");
    expect(rollback?.patch.meta?.["verifySource"]).toBe("global");
  });

  it("sweep()：trigger 下行公开入口——不经 collect 直接巡检 deopt（每 batch 一次）", async () => {
    const { Optimizer } = await import("../../src/pth/kernel/execution/optimizer-loop.js");
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const mem = {
      write: async () => {},
      queryReadOnly: async (sql: string) => {
        if (sql.includes("optimizer-suggestion")) {
          return [{ id: "sug-direct", content: JSON.stringify({ target: "role-doc:dev", evidence: { pattern: "d-pattern" } }),
            meta: { baseline: { avgFails: 1, avgSteps: 4, taskCount: 10 }, appliedAt: Date.now() } }];
        }
        if (sql.includes("verify-aggregate:sug-direct")) return [{ content: JSON.stringify({ taskCount: 3, sumFails: 9, sumSteps: 12 }) }];
        return [];
      },
      update: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); },
    };
    const opt = new Optimizer({ memory: mem as never, windowSize: 2, deadbandWindows: 0, verifyTasksCount: 3, verifySweepMs: 0 });
    await opt.sweep();   // 直接巡检（无需 collect 填窗）
    expect(updates.find((u) => u.id === "sug-direct")?.patch.status).toBe("rolled_back");
  });

  it("sweep()：无 memory 查询面 → no-op（不抛）", async () => {
    const { Optimizer } = await import("../../src/pth/kernel/execution/optimizer-loop.js");
    const opt = new Optimizer({ verifySweepMs: 0 });
    await expect(opt.sweep()).resolves.toBeUndefined();
  });
});

describe("A4 护栏 JIT——guard-config deopt 回滚（2026-08-18）", () => {
  function guardRuntime(initial: Record<string, string>) {
    const values = { ...initial };
    const setCalls: Array<{ key: string; value: string }> = [];
    return {
      values,
      setCalls,
      get: (key: string) => values[key],
      set: (key: string, value: string) => { values[key] = value; setCalls.push({ key, value }); },
    };
  }

  function guardSugRow(over: Record<string, unknown> = {}) {
    return {
      id: "sug-guard",
      content: JSON.stringify({
        id: "sug-guard",
        kind: "guard",
        target: "guard-config:negative-loop",
        section: "阈值",
        content: "【优化建议 · guard-kill-spike】\n建议参数: PTH_GUARD_NEGATIVE_LIMIT ×1.5（当前值由批准时配置中心解析）\n写入目标: guard-config:negative-loop §阈值",
        evidence: { pattern: "guard-kill-spike", tasks: 10, metric: { hits: 8, soft: 5 } },
        guard: { guard: "negative-loop", limitKey: "PTH_GUARD_NEGATIVE_LIMIT", scale: 1.5 },
        status: "draft",
        ts: 1,
      }),
      meta: {
        baseline: { taskCount: 10, avgGuardKills: 1, avgGuardHits: 4 },
        guardBaseline: {
          limitKey: "PTH_GUARD_NEGATIVE_LIMIT",
          from: "15",
          to: "23",
          values: { PTH_GUARD_NEGATIVE_LIMIT: "15" },
        },
        appliedAt: Date.now(),
      },
      ...over,
    };
  }

  it("劣化（avgKills 升 50%+）→ sweep 后 runtimeConfig 恢复原值 + rolledBack + guard-deopt 洞察", async () => {
    const { Optimizer } = await import("../../src/pth/kernel/execution/optimizer-loop.js");
    const rt = guardRuntime({ PTH_GUARD_NEGATIVE_LIMIT: "23" });
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const writes: Array<Record<string, unknown>> = [];
    const mem = {
      write: async (e: Record<string, unknown>) => { writes.push(e); },
      queryReadOnly: async (sql: string) => {
        if (sql.includes("optimizer-suggestion")) return [guardSugRow()];
        if (sql.includes("kind = 'task-scorecard-aggregate'")) {
          // 当前全局聚合：taskCount 12（基线 10 后 +2 ≥ windowSize 2）——avgKills 30/12=2.5（+150% 劣化）
          return [{ content: JSON.stringify({ taskCount: 12, sumGuardKills: 30, sumGuardHits: 60 }) }];
        }
        return [];
      },
      update: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); },
    };
    const opt = new Optimizer({ memory: mem as never, windowSize: 2, deadbandWindows: 0, verifySweepMs: 0, runtimeConfig: rt });
    await opt.sweep();
    const rollback = updates.find((u) => u.id === "sug-guard");
    expect(rollback?.patch.status).toBe("rolled_back");
    expect(rollback?.patch.meta?.["rolledBack"]).toBe(true);
    expect(rollback?.patch.meta?.["verifySource"]).toBe("global");
    expect(rt.values["PTH_GUARD_NEGATIVE_LIMIT"]).toBe("15");
    expect(rt.setCalls).toEqual([{ key: "PTH_GUARD_NEGATIVE_LIMIT", value: "15" }]);
    expect(writes.some((w) => w.kind === "task-insight" && JSON.stringify(w.content).includes("guard-deopt"))).toBe(true);
  });

  it("未劣化 → verified（runtimeConfig 不动）", async () => {
    const { Optimizer } = await import("../../src/pth/kernel/execution/optimizer-loop.js");
    const rt = guardRuntime({ PTH_GUARD_NEGATIVE_LIMIT: "23" });
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const mem = {
      write: async () => {},
      queryReadOnly: async (sql: string) => {
        if (sql.includes("optimizer-suggestion")) return [guardSugRow({ id: "sug-guard-ok" })];
        if (sql.includes("kind = 'task-scorecard-aggregate'")) {
          // avgKills 12/12=1.0（未劣化），avgHits 48/12=4.0（≥ 基线 4*0.5=2）→ verified
          return [{ content: JSON.stringify({ taskCount: 12, sumGuardKills: 12, sumGuardHits: 48 }) }];
        }
        return [];
      },
      update: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); },
    };
    const opt = new Optimizer({ memory: mem as never, windowSize: 2, deadbandWindows: 0, verifySweepMs: 0, runtimeConfig: rt });
    await opt.sweep();
    const verified = updates.find((u) => u.id === "sug-guard-ok");
    expect(verified?.patch.meta?.["verifiedAt"]).toBeDefined();
    expect(verified?.patch.meta?.["verifyAfterWindow"]).toBe(false);
    expect(verified?.patch.meta?.["verifySource"]).toBe("global");
    expect(rt.setCalls).toHaveLength(0);
  });
});
