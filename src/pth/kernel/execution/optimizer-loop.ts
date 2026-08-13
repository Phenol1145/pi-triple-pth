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

// 热点检测与建议渲染抽出至 optimizer-hotspots.ts（2026-08-13 审计 P2——纯函数独立模块）
import { detectHotspots, renderSuggestion, type HotspotHit } from "./optimizer-hotspots.js";
export { READ_TOOLS, detectHotspots, renderSuggestion, type HotspotHit } from "./optimizer-hotspots.js";

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
          // 数据缓存利用率（2026-08-13 N3）：字符量加权——sensor 读聚合视图算利用率（读入未用=浪费）
          ...(sc.cacheUtilization
            ? { sumCacheLoaded: sc.cacheUtilization.loadedChars, sumCacheUsed: sc.cacheUtilization.usedChars }
            : {}),
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
