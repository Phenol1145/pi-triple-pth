/**
 * optimizer-loop —— 优化循环（2026-08-12 大项：roadmap §10.3 生态自进化首环）。
 *
 * 数据流（用户定调——与经典 JIT 的分歧：优化目标不是"同样行为更快"，而是重构分工使每个角色
 * 所需智力下降——让更弱更便宜的模型能胜任更多任务）：
 *
 *   观测（scorecard——任务完成点聚合）
 *     ↓ 热点模式检测（跨任务窗口聚合——规则表数据驱动）
 *   路径 A：规则编译 → 规则建议（role-doc/capability-index 补规则——现有角色变聪明一点）
 *   路径 B：角色编译 → 分化提案（聚合 refiner 的 differentiation-proposal——新窄域角色）
 *     ↓ 流转（draft 落 memory——监督层批准部署；验证闭环：task-scorecard 落库可对比）
 *
 * v1 边界：建议生成 = 数据驱动模板（不调 LLM——先让环转起来，LLM 生成后续升级）；
 * 部署（写 role-doc/capability-index）走监督层（prompt 层只读——draft 建议 + 人工/监督批准）。
 */

import type { WorkerScorecard } from "./worker-scorecard.js";

// ── 类型 ─────────────────────────────────────────────────────

export interface OptimizerSuggestion {
  id: string;
  /** 路径 A（规则编译——现有角色变聪明）/ 路径 B（角色编译——新窄域角色） */
  kind: "rule" | "role";
  /** 建议目标（role-doc:<role> / capability-index / lineage:<parent>） */
  target: string;
  /** 目标文档的分节（写入位置引导） */
  section: string;
  /** 建议内容（模板化文本——数据驱动） */
  content: string;
  /** 证据（触发任务数 + 指标） */
  evidence: {
    pattern: string;
    tasks: number;
    metric: Record<string, number | string>;
  };
  /** 治理：draft（监督层批准后部署——prompt 层只读） */
  status: "draft";
  ts: number;
}

export interface OptimizerDeps {
  /** 落库通道（memory.write——knowledge 层自由写；缺省 = 纯内存（测试））。
   * 用 MemoryEntry 形（PgMemoryStore.write 签名）——避免泛 Record 不兼容 */
  memory?: { write(e: { id?: string; kind: string; anchors?: unknown; content: unknown; status?: string; meta?: Record<string, unknown> }): Promise<unknown> };
  /** 窗口任务数（缺省 10）——满窗触发检测 */
  windowSize?: number;
  /** 建议事件钩子（测试断言 / console 观察） */
  onSuggestion?: (s: OptimizerSuggestion) => void;
}

// ── 热点规则表（数据驱动——可扩展；v1 五条反模式）──────────────

/** 读类工具族（fragmented-read 判定——分片读取反模式：多次小读 vs 一次大读） */
export const READ_TOOLS = ["dev_read", "write_read", "memory_query", "fs_read", "fs_readtext", "asp_index", "memory_index", "debug_snapshot"];

export interface HotspotHit {
  pattern: string;
  path: "rule" | "role";
  target: string;
  section: string;
  metric: Record<string, number | string>;
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

  return hits;
}

// ── 建议生成（模板化——数据驱动）─────────────────────────────

const PATTERN_DESC: Record<string, string> = {
  "gate-heavy": "空间门控命中率高——协议学习成本大：worker 反复触发'请先 asp_cd'类引导，说明空间导航规则未在 prompt 层生效",
  "repeated-fail": "工具调用高频失败——失败动作集中在窗口内反复出现，工具用法/前置条件缺少可复用规则",
  "fragmented-read": "重复分片读取——多次小读替代一次大读（e2e 压缩产物自评'40% 工具调用多余'的实证反模式）",
  "nav-heavy": "空间导航频繁——多次 asp_cd 往返决策，导航路径未规划（先 asp.index 看全貌再 cd）",
  "no-progress": "任务卡死——高步数 + 失败收场：角色-任务匹配或任务设计问题，需要更窄域角色承接",
};

export function renderSuggestion(hit: HotspotHit, windowSize: number): string {
  const desc = PATTERN_DESC[hit.pattern] ?? "反模式";
  const metric = Object.entries(hit.metric).map(([k, v]) => `${k}=${v}`).join(" ");
  const rule =
    hit.pattern === "gate-heavy" ? "空间工具使用前先 asp.index 确认当前空间工具面；门控消息即导航提示（不要重复尝试被拒工具）"
    : hit.pattern === "repeated-fail" ? `工具 ${hit.metric.topTool ?? "?"} 使用前先查 capability-index/tool-function 对应条目（参数/前置条件）；连续失败后切换策略而非重试`
    : hit.pattern === "fragmented-read" ? "读类操作一次拉全（dev_read 全量/query 带聚合）并本地缓存复用；避免同源数据反复小读"
    : hit.pattern === "nav-heavy" ? "导航先规划：asp.index 一次看全空间树 → 单次 asp_cd 直达；避免往返（cd A→B→A）"
    : "任务拆分为更窄子任务（参考 refiner differentiation 提案），由更专门的角色承接";
  return `【优化建议 · ${hit.pattern}】（窗口 ${windowSize} 任务 · ${desc}）
证据: ${metric}
建议规则: ${rule}
写入目标: ${hit.target} §${hit.section}`;
}

// ── 优化器（窗口收集 → 检测 → 建议 → 落库）───────────────────

const MAX_BUFFER = 200;   // 缓冲上限（防内存无界——窗口不触发时丢弃最旧）

export class Optimizer {
  private deps: OptimizerDeps;
  private windowSize: number;
  private buffer: WorkerScorecard[] = [];
  private suggestions: OptimizerSuggestion[] = [];   // 测试/观察用（内存侧）
  private lastDetectAt = 0;

  constructor(deps: OptimizerDeps = {}) {
    this.deps = deps;
    this.windowSize = Math.max(1, deps.windowSize ?? 10);
  }

  /** 任务完成点收集（scorecard）——窗口满触发检测 */
  collect(sc: WorkerScorecard, ctx: { role: string; taskId: string }): void {
    this.buffer.push(sc);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    // scorecard 落库（验证闭环数据源——anchors 带角色/任务类型）
    void this.deps.memory?.write({
      kind: "task-scorecard",
      anchors: [ctx.role, "scorecard"],
      content: sc,
      status: "official",
      meta: { taskId: ctx.taskId, role: ctx.role, ts: Date.now() },
    }).catch(() => { /* 落库失败不阻塞任务循环 */ });
    if (this.buffer.length >= this.windowSize) {
      const window = this.buffer.splice(0, this.windowSize);
      this.detect(window);
    }
  }

  /** 窗口检测 → 建议生成 → 落库（draft） */
  detect(window: WorkerScorecard[]): OptimizerSuggestion[] {
    const hits = detectHotspots(window);
    const out: OptimizerSuggestion[] = [];
    for (const hit of hits) {
      const s: OptimizerSuggestion = {
        id: `opt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        kind: hit.path,
        target: hit.target,
        section: hit.section,
        content: renderSuggestion(hit, window.length),
        evidence: { pattern: hit.pattern, tasks: window.length, metric: hit.metric },
        status: "draft",
        ts: Date.now(),
      };
      out.push(s);
      this.suggestions.push(s);
      this.deps.onSuggestion?.(s);
      void this.deps.memory?.write({
        id: s.id,
        kind: "optimizer-suggestion",
        anchors: [hit.pattern, hit.target],
        content: s,
        status: "draft",
        meta: { pattern: hit.pattern, target: hit.target, ts: s.ts },
      }).catch(() => { /* 落库失败不阻塞 */ });
    }
    this.lastDetectAt = Date.now();
    return out;
  }

  /** 观察（测试/console） */
  pending(): OptimizerSuggestion[] {
    return [...this.suggestions];
  }
}
