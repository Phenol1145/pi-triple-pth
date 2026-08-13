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
   * 用 MemoryEntry 形（PgMemoryStore.write 签名）——避免泛 Record 不兼容。
   * incrementAggregate：scorecard 聚合快照原子 upsert（2026-08-12 审批面 B——
   * 单条 SQL 增量——避免读-改-写竞态）；缺省 = 跳过聚合（明细仍落库——降级逐条读） */
  memory?: {
    write(e: { id?: string; kind: string; anchors?: unknown; content: unknown; status?: string; meta?: Record<string, unknown> }): Promise<unknown>;
    incrementAggregate?(id: string, kind: string, anchors: unknown[], deltas: Record<string, number>, meta: Record<string, unknown>): Promise<void>;
    /** 只读查询（deopt 复测读聚合/建议——2026-08-13） */
    queryReadOnly?(sql: string): Promise<unknown>;
    /** 条目更新（deopt 回滚移除规则 stamp——2026-08-13） */
    update?(id: string, patch: { content?: string; status?: string; meta?: Record<string, unknown> }): Promise<unknown>;
  };
  /** 窗口任务数（缺省 10）——满窗触发检测 */
  windowSize?: number;
  /** 建议事件钩子（测试断言 / console 观察） */
  onSuggestion?: (s: OptimizerSuggestion) => void;
  /** 振荡防护死区（待决点 4 落地——2026-08-12）：同 pattern 在 N 个窗口内不重复建议
   *  （规则已应用则等待复测验证——连续窗口重复建议 = 振荡）。缺省 2（死区 = 2×windowSize 任务）。 */
  deadbandWindows?: number;
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
};

export function renderSuggestion(hit: HotspotHit, windowSize: number): string {
  const desc = PATTERN_DESC[hit.pattern] ?? "反模式";
  const metric = Object.entries(hit.metric).map(([k, v]) => `${k}=${v}`).join(" ");
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

// ── 优化器（窗口收集 → 检测 → 建议 → 落库）───────────────────

const MAX_BUFFER = 200;   // 缓冲上限（防内存无界——窗口不触发时丢弃最旧）

export class Optimizer {
  private deps: OptimizerDeps;
  private windowSize: number;
  private buffer: WorkerScorecard[] = [];
  private suggestions: OptimizerSuggestion[] = [];   // 测试/观察用（内存侧）
  private lastDetectAt = 0;
  /** 振荡防护（待决点 4）：pattern → 最近建议窗口序号（死区窗口数内同 pattern 不重复） */
  private patternLastSuggested = new Map<string, number>();
  private windowSeq = 0;
  private deadbandWindows: number;

  constructor(deps: OptimizerDeps = {}) {
    this.deps = deps;
    this.windowSize = Math.max(1, deps.windowSize ?? 10);
    this.deadbandWindows = Math.max(0, deps.deadbandWindows ?? 2);
  }

  /** 任务完成点收集（scorecard + 聚合快照）——窗口满触发检测 */
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
    }).catch((e: unknown) => { /* 2026-08-12 审计 MEDIUM-7：不再静默——落库失败可见（历史三连 SQL bug 曾此吞掉） */
      console.warn(`[optimizer] scorecard 落库失败: ${e instanceof Error ? e.message : String(e)}`);
    });
    // 增量聚合快照（2026-08-12 JIT 审批面 B——diff-scorecard-aggregate-msq36a60 实施）：
    // kind=task-scorecard-aggregate 按角色累积——sensor 直接读聚合视图不逐条 parse。
    // 原子 upsert（单条 SQL jsonb 增量——并发同角色任务无 lost update）
    if (this.deps.memory?.incrementAggregate) {
      void this.deps.memory.incrementAggregate(
        `task-scorecard-aggregate:${ctx.role}`,
        "task-scorecard-aggregate",
        [ctx.role, "scorecard-aggregate"],
        {
          taskCount: 1,
          sumSteps: sc.steps ?? 0,
          sumTokIn: sc.tokens?.input ?? 0,
          sumTokOut: sc.tokens?.output ?? 0,
          sumCacheRead: sc.tokens?.cacheRead ?? 0,
          sumCacheWrite: sc.tokens?.cacheWrite ?? 0,
          sumFails: sc.failedActions ?? 0,
          sumGated: sc.gatedActions ?? 0,
          // 时间复用率（2026-08-13 监测量）：sum/planCount 均值——obs 端 avg_time_reuse
          ...(sc.timeReuse != null ? { sumTimeReuse: sc.timeReuse, planCount: 1 } : {}),
        },
        { role: ctx.role, ts: Date.now() },
      ).catch((e: unknown) => { /* 聚合失败不阻塞（明细仍在——降级逐条读）；但错误须可见（2026-08-12 审计 MEDIUM-7） */
        console.warn(`[optimizer] 聚合快照失败（降级明细）: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    if (this.buffer.length >= this.windowSize) {
      const window = this.buffer.splice(0, this.windowSize);
      this.detect(window);
    }
  }

  /** 窗口检测 → 建议生成 → 落库（draft）
   *  振荡防护（待决点 4）：同 pattern 在 deadbandWindows 窗口内已建议过 → 跳过（死区——
   *  规则已应用则等待复测验证；未应用则监督层未批——重复建议无意义） */
  detect(window: WorkerScorecard[]): OptimizerSuggestion[] {
    this.windowSeq++;
    // deopt 回滚复测（2026-08-13 稳定循环刹车）：窗口检测时顺带检查已应用建议——
    // 基线对比劣化则移除规则 stamp（fire-and-forget——不阻塞检测）
    if (this.deps.memory?.queryReadOnly && this.deps.memory?.update) void this.checkDeopt().catch((e: unknown) => {
      console.warn(`[optimizer] deopt 复测失败: ${e instanceof Error ? e.message : String(e)}`);
    });
    const hits = detectHotspots(window);
    const out: OptimizerSuggestion[] = [];
    for (const hit of hits) {
      const lastSeq = this.patternLastSuggested.get(hit.pattern) ?? -Infinity;
      if (this.windowSeq - lastSeq <= this.deadbandWindows) continue;   // 死区内——跳过
      this.patternLastSuggested.set(hit.pattern, this.windowSeq);
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

  /**
   * deopt 回滚（2026-08-13 稳定循环刹车——用户裁决"不优于基线 deopt 回滚"落地）。
   * 已应用建议（meta.baseline 存在且未回滚）→ 目标角色聚合指标与基线对比：
   * 复测成熟（基线后新任务数 ≥ 窗口）且劣化（avgFails/avgSteps 升 50%+）→
   * 从目标资产移除规则 stamp + 建议状态 rolled_back + 落回滚 insight。
   */
  private async checkDeopt(): Promise<void> {
    const mem = this.deps.memory!;
    const rows = await mem.queryReadOnly!(
      `SELECT id, content, meta FROM memory_entries WHERE kind = 'optimizer-suggestion' AND status = 'official' AND meta->>'baseline' IS NOT NULL AND meta->>'rolledBack' IS NULL`,
    ) as Array<{ id: string; content: string; meta: Record<string, unknown> }>;
    for (const row of rows) {
      try {
        const sug = (typeof row.content === "string" ? JSON.parse(row.content) : row.content) as OptimizerSuggestion;
        const target = sug.target;
        const pattern = sug.evidence?.pattern ?? "rule";
        const roleId = target.startsWith("role-doc:") ? target.slice("role-doc:".length) : undefined;
        if (!roleId) continue;   // capability-index 目标暂不做角色指标对比
        const aggRows = await mem.queryReadOnly!(
          `SELECT content FROM memory_entries WHERE id = 'task-scorecard-aggregate:${roleId}'`,
        ) as Array<{ content: string }>;
        const a = aggRows[0] ? JSON.parse(String(aggRows[0].content)) as Record<string, number> : undefined;
        if (!a?.taskCount) continue;
        const baseline = row.meta?.["baseline"] as { avgFails: number; avgSteps: number; taskCount: number } | undefined;
        if (!baseline) continue;
        // 复测成熟：基线后新积累任务 ≥ 窗口
        if (a.taskCount - baseline.taskCount < this.windowSize) continue;
        const current = { avgFails: (a.sumFails ?? 0) / a.taskCount, avgSteps: (a.sumSteps ?? 0) / a.taskCount };
        const worse = current.avgFails > baseline.avgFails * 1.5 || current.avgSteps > baseline.avgSteps * 1.5;
        if (!worse) {
          // 指标未劣化——规则有效——移除基线（不再反复复测）
          await mem.update!(row.id, { meta: { ...row.meta, verifyAfterWindow: false } } as never);
          continue;
        }
        // 回滚：从目标资产移除该 pattern 的规则 stamp
        const doc = await mem.queryReadOnly!(`SELECT content FROM memory_entries WHERE id = '${target}'`) as Array<{ content: string }>;
        const docContent = String(doc[0]?.content ?? "");
        const stampRe = new RegExp(`\n\n【优化规则 · ${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\n]*】\n- [^\n]*`);
        const cleaned = docContent.replace(stampRe, "");
        if (cleaned !== docContent) {
          await mem.update!(target, { content: cleaned });
        }
        await mem.update!(row.id, {
          status: "rolled_back",
          meta: { ...row.meta, rolledBack: true, rolledBackAt: Date.now(), rollbackReason: `指标劣化（avgFails ${baseline.avgFails.toFixed(2)}→${current.avgFails.toFixed(2)} / avgSteps ${baseline.avgSteps.toFixed(1)}→${current.avgSteps.toFixed(1)}）` },
        } as never);
        void mem.write({
          kind: "task-insight",
          anchors: ["deopt", pattern, roleId],
          content: JSON.stringify({
            type: "deopt-rollback", pattern, target, roleId,
            baseline, current, rolledBackAt: Date.now(),
            note: "优化规则应用后指标劣化——已自动回滚（deopt 刹车——不优于基线即撤）",
          }),
          status: "official",
          meta: { pattern, role: roleId, ts: Date.now() },
        }).catch(() => { /* 回滚 insight 落库失败不阻塞 */ });
        console.warn(`[optimizer] deopt 回滚: ${pattern}（${roleId}——基线 ${baseline.avgFails.toFixed(2)}→${current.avgFails.toFixed(2)} fails）`);
      } catch (e) {
        console.warn(`[optimizer] deopt 单条复测失败 ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** 观察（测试/console） */
  pending(): OptimizerSuggestion[] {
    return [...this.suggestions];
  }
}
