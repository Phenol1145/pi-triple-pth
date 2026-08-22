/**
 * optimizer-hotspots.ts —— JIT 热点规则表与建议渲染（2026-08-13 审计 P2：从 optimizer-loop 抽出——
 * 纯函数 + 数据驱动规则表独立成模块：检测规则可扩展、可独立测试，optimizer-loop 收敛为收集/落库编排。
 */

import type { WorkerScorecard } from "./worker-scorecard.js";
import { GUARD_TUNABLE_DEFS } from "./guardrails.js";
// ── 热点规则表（数据驱动——可扩展；v1 五条反模式）──────────────

/** 读类工具族（fragmented-read 判定——分片读取反模式：多次小读 vs 一次大读） */
export const READ_TOOLS = ["dev_read", "write_read", "memory_query", "fs_read", "fs_readtext", "asp_index", "memory_index", "debug_snapshot"];

export interface HotspotHit {
  pattern: string;
  path: "rule" | "role" | "guard";
  target: string;
  section: string;
  metric: Record<string, number | string>;
  /** A4 护栏 JIT：guard 路径的调参建议（与 OptimizerSuggestion.guard 同形） */
  guard?: { guard: string; limitKey: string; scale: number };
}

/** 跨任务窗口热点检测（纯函数——数据驱动规则表） */
export function detectHotspots(scs: WorkerScorecard[]): HotspotHit[] {
  const hits: HotspotHit[] = [];
  if (scs.length === 0) return hits;

  const agg = {
    steps: scs.reduce((a, s) => a + s.steps, 0),
    gated: scs.reduce((a, s) => a + s.gatedActions, 0),
    failed: scs.reduce((a, s) => a + s.failedActions, 0),
    toolCalls: scs.reduce((a, s) => a + Object.values(s.toolFreq).reduce((x, y) => x + y, 0), 0),
    cds: scs.reduce((a, s) => a + s.aspNav.cds, 0),
    failedTasks: scs.filter((s) => s.finish?.ok === false).length,
  };
  // 工具级聚合（repeated-fail 判定）
  const toolAgg = new Map<string, { calls: number; fails: number }>();
  for (const sc of scs) {
    for (const [tool, n] of Object.entries(sc.toolFreq)) {
      const rec = toolAgg.get(tool) ?? { calls: 0, fails: 0 };
      rec.calls += n;
      toolAgg.set(tool, rec);
    }
  }
  // failedActions 无工具维度（scorecard 聚合粒度）——repeated-fail 用"调用占比 + 失败率"近似：
  // 窗口内失败总数分摊到高频工具（证据引用任务级 fail 率）

  // 1. gate-heavy：空间门控命中占比高 → 协议 prompt 缺陷（路径 A——capability-index 补导航规则）
  if (agg.steps > 0 && agg.gated >= 5 && agg.gated / agg.steps > 0.3) {
    hits.push({
      pattern: "gate-heavy",
      path: "rule",
      target: "capability-index",
      section: "## 空间协议",
      metric: { gated: agg.gated, steps: agg.steps, ratio: +(agg.gated / agg.steps).toFixed(2) },
    });
  }

  // 2. repeated-fail：窗口失败率高（≥50% 任务带失败 + 总失败 ≥ 调用 15%）
  const toolCalls = agg.toolCalls;
  if (agg.failed >= 3 && toolCalls > 0 && agg.failed / toolCalls > 0.15) {
    const topTool = [...toolAgg.entries()].sort((a, b) => b[1].calls - a[1].calls)[0];
    hits.push({
      pattern: "repeated-fail",
      path: "rule",
      target: topTool ? `tool-function:${topTool[0]}` : "capability-index",
      section: "## 工具用法",
      metric: { failed: agg.failed, toolCalls, failRate: +(agg.failed / toolCalls).toFixed(2), topTool: topTool?.[0] ?? "?" },
    });
  }

  // 3. fragmented-read：读族工具调用占比高（roadmap 首个实证反模式——e2e 自评"40% 工具调用多余"）
  const readCalls = scs.reduce(
    (a, s) => a + Object.entries(s.toolFreq).filter(([t]) => READ_TOOLS.includes(t)).reduce((x, [, n]) => x + n, 0),
    0,
  );
  if (readCalls >= 6 && toolCalls > 0 && readCalls / toolCalls >= 0.4) {
    hits.push({
      pattern: "fragmented-read",
      path: "rule",
      target: "capability-index",
      section: "## 读取策略",
      metric: { readCalls, toolCalls, ratio: +(readCalls / toolCalls).toFixed(2) },
    });
  }

  // 4. nav-heavy：空间导航频繁（asp_cd ≥4——每次 cd 都是一次往返决策）
  if (agg.cds >= 4) {
    hits.push({
      pattern: "nav-heavy",
      path: "rule",
      target: "capability-index",
      section: "## 空间协议",
      metric: { cds: agg.cds, tasks: scs.length },
    });
  }

  // 5. no-progress：任务卡死（失败 + 高步数）→ 路径 B（角色分化——聚合 refiner 提案的触发信号）
  if (agg.failedTasks > 0 && agg.steps >= 30) {
    hits.push({
      pattern: "no-progress",
      path: "role",
      target: "lineage:executor",
      section: "分化提案",
      metric: { failedTasks: agg.failedTasks, steps: agg.steps },
    });
  }

  // 6. plan-deep：时间复用率低（2026-08-13 监测量——planner 计划过深——扁平化引导）
  const plans = scs.filter((s) => s.timeReuse != null);
  if (plans.length > 0) {
    const avgReuse = plans.reduce((a, s) => a + (s.timeReuse ?? 0), 0) / plans.length;
    if (avgReuse < 0.3) {
      hits.push({
        pattern: "plan-deep",
        path: "rule",
        target: "role-doc:planner",
        section: "计划格式",
        metric: { avgTimeReuse: +avgReuse.toFixed(2), planTasks: plans.length },
      });
    }
  }

  // 7. cache-waste：数据缓存读入未用（2026-08-13 N3——0.11.4.3 数据流效率——低利用率=读入未用浪费信号）
  const cacheScs = scs.filter((s) => s.cacheUtilization && s.cacheUtilization.loadedChars > 0);
  if (cacheScs.length >= 3) {
    const totLoaded = cacheScs.reduce((a, s) => a + (s.cacheUtilization?.loadedChars ?? 0), 0);
    const totUsed = cacheScs.reduce((a, s) => a + (s.cacheUtilization?.usedChars ?? 0), 0);
    const ratio = totLoaded > 0 ? totUsed / totLoaded : 0;
    if (totLoaded >= 500 && ratio < 0.5) {
      hits.push({
        pattern: "cache-waste",
        path: "rule",
        target: "capability-index",
        section: "## 缓存策略",
        metric: { loadedChars: totLoaded, usedChars: totUsed, ratio: +ratio.toFixed(2), cacheTasks: cacheScs.length },
      });
    }
  }

  // 8. guard-kill-spike（A4 护栏 JIT）：窗口聚合 scorecard.guards——护栏误杀尖峰。
  // 保守单规则：只从 GUARD_TUNABLE_DEFS（软处置/负结果族）中选窗口 kills 最多的护栏；
  // hard 契约护栏（empty-done/empty-reply/unknown-tool）不自动建议放宽。
  const guardAgg = new Map<string, { hits: number; guide: number; soft: number; hard: number; tasks: number }>();
  for (const s of scs) {
    const g = s.guards;
    if (!g) continue;
    const ids = new Set<string>();
    for (const gid of Object.keys(g.hits ?? {})) ids.add(gid);
    for (const gid of Object.keys(g.guide ?? {})) ids.add(gid);
    for (const gid of Object.keys(g.soft ?? {})) ids.add(gid);
    for (const gid of Object.keys(g.hard ?? {})) ids.add(gid);
    for (const gid of ids) {
      const rec = guardAgg.get(gid) ?? { hits: 0, guide: 0, soft: 0, hard: 0, tasks: 0 };
      rec.hits += Number(g.hits?.[gid]) || 0;
      rec.guide += Number(g.guide?.[gid]) || 0;
      rec.soft += Number(g.soft?.[gid]) || 0;
      rec.hard += Number(g.hard?.[gid]) || 0;
      rec.tasks += 1;
      guardAgg.set(gid, rec);
    }
  }
  const guardCandidates: Array<{ gid: string; rec: { hits: number; guide: number; soft: number; hard: number; tasks: number }; kills: number }> = [];
  for (const gid of Object.keys(GUARD_TUNABLE_DEFS)) {
    const rec = guardAgg.get(gid);
    if (!rec) continue;
    const kills = rec.soft + rec.hard;
    if (rec.hard >= 3 || (kills >= 5 && rec.hits > 0 && kills / rec.hits > 0.5)) {
      guardCandidates.push({ gid, rec, kills });
    }
  }
  if (guardCandidates.length > 0) {
    guardCandidates.sort((a, b) => b.kills - a.kills);
    const top = guardCandidates[0]!;
    const def = GUARD_TUNABLE_DEFS[top.gid]!;
    hits.push({
      pattern: "guard-kill-spike",
      path: "guard",
      target: `guard-config:${top.gid}`,
      section: "阈值",
      metric: {
        hits: top.rec.hits,
        guide: top.rec.guide,
        soft: top.rec.soft,
        hard: top.rec.hard,
        killRatio: +(top.rec.hits > 0 ? top.kills / top.rec.hits : 0).toFixed(2),
        tasks: top.rec.tasks,
      },
      guard: { guard: top.gid, limitKey: def.limitKey, scale: 1.5 },
    });
  }

  return hits;
}

// ── 建议生成（模板化——数据驱动）─────────────────────────────

const PATTERN_DESC: Record<string, string> = {
  "gate-heavy": "空间门控命中率高——协议学习成本大：worker 反复触发'请先 asp_cd'类引导，说明空间导航规则未在 prompt 层生效",
  "repeated-fail": "工具调用高频失败——失败动作集中在窗口内反复出现，工具用法/前置条件缺少可复用规则",
  "fragmented-read": "重复分片读取——多次小读替代一次大读（e2e 压缩产物自评'40% 工具调用多余'的实证反模式）",
  "nav-heavy": "空间导航频繁——多次 asp_cd 往返决策，导航路径未规划（先 asp.index 看全貌再 cd）",
  "no-progress": "任务卡死——高步数 + 失败收场：角色-任务匹配或任务设计问题，需要更窄域角色承接",
  "plan-deep": "计划过深（时间复用率低）——planner 产出的计划串行链过长，无依赖子任务未并行化——时间复用率 = 1-关键路径/总任务数",
  "cache-waste": "数据缓存读入未用——cache.load 读入大量数据但未 get 取用（读入成本已付、信息未消费——0.11 数据流效率）",
  "guard-kill-spike": "护栏误杀尖峰——窗口内软/硬终止集中在某护栏，阈值偏紧导致误杀；建议放宽该软处置护栏阈值（hard 契约护栏不自动放宽）",
};

export function renderSuggestion(hit: HotspotHit, windowSize: number): string {
  const desc = PATTERN_DESC[hit.pattern] ?? "反模式";
  const metric = Object.entries(hit.metric).map(([k, v]) => `${k}=${v}`).join(" ");
  if (hit.path === "guard") {
    const limitKey = hit.guard?.limitKey ?? "?";
    const scale = hit.guard?.scale ?? 1.5;
    return `【优化建议 · ${hit.pattern}】（窗口 ${windowSize} 任务 · ${desc}）
证据: ${metric}
建议参数: ${limitKey} ×${scale}（当前值由批准时配置中心解析）
写入目标: ${hit.target} §${hit.section}`;
  }
  const rule =
    hit.pattern === "gate-heavy" ? "空间工具使用前先 asp.index 确认当前空间工具面；门控消息即导航提示（不要重复尝试被拒工具）"
    : hit.pattern === "repeated-fail" ? `工具 ${hit.metric.topTool ?? "?"} 使用前先查 capability-index/tool-function 对应条目（参数/前置条件）；连续失败后切换策略而非重试`
    : hit.pattern === "fragmented-read" ? "读类操作一次拉全（dev_read 全量/query 带聚合）并本地缓存复用；避免同源数据反复小读"
    : hit.pattern === "nav-heavy" ? "导航先规划：asp.index 一次看全空间树 → 单次 asp_cd 直达；避免往返（cd A→B→A）"
    : hit.pattern === "plan-deep" ? "计划扁平化：dependsOn 只标真实数据依赖——无依赖子任务不串排（同层并行——时间复用）；先画依赖 DAG 再排顺序"
    : "任务拆分为更窄子任务（参考 refiner differentiation 提案），由更专门的角色承接";
  return `【优化建议 · ${hit.pattern}】（窗口 ${windowSize} 任务 · ${desc}）
证据: ${metric}
建议规则: ${rule}
写入目标: ${hit.target} §${hit.section}`;
}
