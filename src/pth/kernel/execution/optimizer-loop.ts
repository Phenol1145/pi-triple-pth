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

import { createHash } from "node:crypto";
import type { WorkerScorecard } from "./worker-scorecard.js";
import { config } from "../extensions/perf-params.js";
import { DEFAULT_TENANT_ID } from "@away_from/pth-memory";

// ── 类型 ─────────────────────────────────────────────────────

export interface OptimizerSuggestion {
  id: string;
  /** 路径 A（规则编译——现有角色变聪明）/ 路径 B（角色编译——新窄域角色）/ guard（护栏 JIT 调参） */
  kind: "rule" | "role" | "guard";
  /** 建议目标（role-doc:<role> / capability-index / lineage:<parent> / guard-config:<guardId>） */
  target: string;
  /** 目标文档的分节（写入位置引导；guard 路径 = 阈值） */
  section: string;
  /** 建议内容（模板化文本——数据驱动） */
  content: string;
  /** A4 护栏 JIT：guard 建议的调参信息（从 HotspotHit 带入，与 HotspotHit.guard 同形） */
  guard?: { guard: string; limitKey: string; scale: number };
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
    write(e: { id?: string; tenantId?: string; kind: string; anchors?: unknown; content: unknown; status?: string; meta?: Record<string, unknown> }): Promise<unknown>;
    incrementAggregate?(id: string, kind: string, anchors: unknown[], deltas: Record<string, number>, meta: Record<string, unknown>, opts?: { tenantId?: string }): Promise<void>;
    /** 只读查询（deopt 复测读聚合/建议——2026-08-13） */
    queryReadOnly?(sql: string): Promise<unknown>;
    /** 条目更新（deopt 回滚移除规则 stamp——2026-08-13） */
    update?(id: string, patch: { content?: string; status?: string; meta?: Record<string, unknown> }, opts?: { tenantId?: string }): Promise<unknown>;
  };
  /** 窗口任务数（缺省 10）——满窗触发检测 */
  windowSize?: number;
  /** 建议事件钩子（测试断言 / console 观察） */
  onSuggestion?: (s: OptimizerSuggestion) => void;
  /** 振荡防护死区（待决点 4 落地——2026-08-12）：同 pattern 在 N 个窗口内不重复建议
   *  （规则已应用则等待复测验证——连续窗口重复建议 = 振荡）。缺省 2（死区 = 2×windowSize 任务）。 */
  deadbandWindows?: number;
  /** 可逆微调自动应用（2026-08-14 T4 分层闸门）：PTH_APPLY_POLICY=auto-reversible 时装配层注入。
   *  仅可逆建议（capability-index/role-doc）自动 apply + deopt 兜底；不可逆永远走人工。 */
  autoApplyReversible?: boolean;
  /** 自动应用执行器（装配层注入 applyOptimizerSuggestion） */
  applySuggestion?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /** 复测任务数（2026-08-14 N6 一等化）：独立复测任务完成 N 个即结算（受控证据——缺省 3） */
  verifyTasksCount?: number;
  /** 复测超时（N6）：无证据进展时 deadline 后标记 verify_expired（诚实缺口可见——缺省 30min） */
  verifyTimeoutMs?: number;
  /** 复测巡检周期（N6）：checkDeopt 独立触发——不再只挂窗口检测（缺省 30s；0=禁用——测试） */
  verifySweepMs?: number;
  /** 运行时配置（A4 护栏 JIT：guard deopt 回滚原值——缺省 perf-params config()；测试注入 fake） */
  runtimeConfig?: { get(key: string): string | undefined; set(key: string, value: string): void };
}

// 热点检测与建议渲染抽出至 optimizer-hotspots.ts（2026-08-13 审计 P2——纯函数独立模块）
import { detectHotspots, renderSuggestion, type HotspotHit } from "./optimizer-hotspots.js";
export { READ_TOOLS, detectHotspots, renderSuggestion, type HotspotHit } from "./optimizer-hotspots.js";

// ── 优化器（窗口收集 → 检测 → 建议 → 落库）───────────────────

// ── 聚合 rollup（2026-08-14 N6 一等化）───────────────────

/** 聚合行 rollup：跨角色聚合求和（capability-index 目标的全局复测基线/对比——
 * 目标无单一角色指标，用全角色聚合的求和作为诚实证据）。单条坏 JSON 跳过。 */
export function rollupAggregateRows(rows: Array<{ content: string }>): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const r of rows) {
    try {
      const a = JSON.parse(String(r.content)) as Record<string, number>;
      for (const k of ["taskCount", "sumFails", "sumSteps", "sumGuardHits", "sumGuardSoft", "sumGuardHard", "sumGuardKills"]) {
        acc[k] = (acc[k] ?? 0) + (Number(a[k]) || 0);
      }
    } catch { /* 单条坏聚合跳过 */ }
  }
  return acc;
}

const MAX_BUFFER = 200;   // 缓冲上限（防内存无界——窗口不触发时丢弃最旧）

/** N19 Phase 1b：official task-insight 现要求 meta.provenance（六字段）——deopt 洞察补齐。 */
function deoptInsightMeta(content: string, suggestionId: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    provenance: {
      sourceTaskId: suggestionId,
      producerRole: "optimizer-loop",
      producerModel: "optimizer-loop",
      sourceRefs: [`optimizer-suggestion:${suggestionId}`],
      contentHash: createHash("sha256").update(content).digest("hex"),
      createdAt: Date.now(),
    },
  };
}

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
  private verifyTasksCount: number;
  private verifyTimeoutMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: OptimizerDeps = {}) {
    this.deps = deps;
    this.windowSize = Math.max(1, deps.windowSize ?? 10);
    this.deadbandWindows = Math.max(0, deps.deadbandWindows ?? 2);
    this.verifyTasksCount = Math.max(1, deps.verifyTasksCount ?? 3);
    this.verifyTimeoutMs = deps.verifyTimeoutMs ?? 30 * 60_000;
    // 复测巡检（2026-08-14 N6）：checkDeopt 独立周期触发——不再只挂窗口检测
    // （流量枯竭时窗口永不填满 → 复测悬挂）。unref 不阻塞进程退出。
    const sweepMs = deps.verifySweepMs ?? 30_000;
    if (sweepMs > 0 && deps.memory?.queryReadOnly && deps.memory?.update) {
      this.sweepTimer = setInterval(() => { void this.checkDeopt().catch(() => { /* 巡检容错 */ }); }, sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  /** 停表（batch 角色移除时调用——清理巡检定时器） */
  stop(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }

  /** trigger 统一化（2026-08-16）：复测巡检公开入口——主进程 optimizer.deopt-sweep trigger
   *  经 IPC 下行调用。每 batch 只需跑一次（checkDeopt 读共享 memory，无实例态）。 */
  async sweep(): Promise<void> {
    if (!this.deps.memory?.queryReadOnly || !this.deps.memory.update) return;
    await this.checkDeopt();
  }

  /** 任务完成点收集（scorecard + 聚合快照）——窗口满触发检测 */
  collect(sc: WorkerScorecard, ctx: { role: string; taskId: string; tenantId?: string; verifyOf?: string }): void {
    const tenantId = ctx.tenantId ?? DEFAULT_TENANT_ID;
    if (ctx.verifyOf) {
      // 复测任务（2026-08-14 N6 一等化）：受控证据——不进热点窗口、不进角色聚合
      // （两者都应是纯有机流量——复测场景会系统性偏置热点检测与基线对比）；
      // 只进 verify-aggregate（按建议键控——checkDeopt 的受控结算通道）
      if (this.deps.memory?.incrementAggregate) {
        void this.deps.memory.incrementAggregate(
          `verify-aggregate:${ctx.verifyOf}`,
          "verify-aggregate",
          [ctx.verifyOf, "verify"],
          { taskCount: 1, sumFails: sc.failedActions ?? 0, sumSteps: sc.steps ?? 0 },
          { verifyOf: ctx.verifyOf, role: ctx.role, ts: Date.now() },
          { tenantId },
        ).catch((e: unknown) => {
          console.warn(`[optimizer] 复测聚合失败: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
      return;
    }
    this.buffer.push(sc);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    // scorecard 落库（验证闭环数据源——anchors 带角色/任务类型）
    void this.deps.memory?.write({
      kind: "task-scorecard",
      tenantId,
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
      // A4 护栏 JIT（2026-08-18）：护栏观测面一并进角色聚合——guard deopt 全局 rollup 的 flat 键。
      const guards = sc.guards ?? { hits: {}, guide: {}, soft: {}, hard: {} };
      const sumGuardHits = Object.values(guards.hits ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
      const sumGuardSoft = Object.values(guards.soft ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
      const sumGuardHard = Object.values(guards.hard ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
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
          sumGuardHits,
          sumGuardSoft,
          sumGuardHard,
          sumGuardKills: sumGuardSoft + sumGuardHard,
          // 时间复用率（2026-08-13 监测量）：sum/planCount 均值——obs 端 avg_time_reuse
          ...(sc.timeReuse != null ? { sumTimeReuse: sc.timeReuse, planCount: 1 } : {}),
          // 数据缓存利用率（2026-08-13 N3）：字符量加权——sensor 读聚合视图算利用率（读入未用=浪费）
          ...(sc.cacheUtilization
            ? { sumCacheLoaded: sc.cacheUtilization.loadedChars, sumCacheUsed: sc.cacheUtilization.usedChars }
            : {}),
        },
        { role: ctx.role, ts: Date.now() },
        { tenantId },
      ).catch((e: unknown) => { /* 聚合失败不阻塞（明细仍在——降级逐条读）；但错误须可见（2026-08-12 审计 MEDIUM-7） */
        console.warn(`[optimizer] 聚合快照失败（降级明细）: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    if (this.buffer.length >= this.windowSize) {
      const window = this.buffer.splice(0, this.windowSize);
      const created = this.detect(window);
      // 2026-08-14 T4 分层闸门：可逆微调自动 apply（仅当装配层开启策略）+ deopt 兜底；
      // 不可逆建议（分化/代码/删除）不在此列——人工闸门。
      if (this.deps.autoApplyReversible && this.deps.applySuggestion) {
        for (const s of created) {
          if (s.target === "capability-index" || s.target.startsWith("role-doc:")) {
            void this.deps.applySuggestion(s.id).then((r) => {
              if (!r.ok) console.warn(`[optimizer] 自动应用失败 ${s.id}: ${r.error ?? "unknown"}`);
            }).catch((e: unknown) => {
              console.warn(`[optimizer] 自动应用异常 ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
            });
          }
        }
      }
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
        ...(hit.guard ? { guard: hit.guard } : {}),
      };
      out.push(s);
      this.suggestions.push(s);
      this.deps.onSuggestion?.(s);
      void this.deps.memory?.write({
        id: s.id,
        tenantId: DEFAULT_TENANT_ID,
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

  /** 读复测聚合（N6——独立复测任务受控证据） */
  private async readVerifyAgg(id: string): Promise<Record<string, number> | undefined> {
    const rows = await this.deps.memory!.queryReadOnly!(`SELECT content FROM memory_entries WHERE id = 'verify-aggregate:${id}'`) as Array<{ content: string }>;
    return rows[0] ? JSON.parse(String(rows[0].content)) as Record<string, number> : undefined;
  }
  /** 读角色聚合（有机流量证据） */
  private async readRoleAgg(roleId: string): Promise<Record<string, number> | undefined> {
    const rows = await this.deps.memory!.queryReadOnly!(`SELECT content FROM memory_entries WHERE id = 'task-scorecard-aggregate:${roleId}'`) as Array<{ content: string }>;
    return rows[0] ? JSON.parse(String(rows[0].content)) as Record<string, number> : undefined;
  }
  /** 读全局聚合（capability-index 目标——跨角色 rollup） */
  private async readGlobalAgg(): Promise<Record<string, number> | undefined> {
    const rows = await this.deps.memory!.queryReadOnly!(`SELECT content FROM memory_entries WHERE kind = 'task-scorecard-aggregate'`) as Array<{ content: string }>;
    const acc = rollupAggregateRows(rows);
    return acc.taskCount ? acc : undefined;
  }
  /**
   * deopt 回滚（2026-08-13 稳定循环刹车——用户裁决「不优于基线 deopt 回滚」落地；
   * 2026-08-14 N6 复测一等化：证据三通道——独立复测任务（受控）＞角色有机流量 ＞ 全局聚合，
   * 超时零进展 → verify_expired（诚实缺口可见，不再静默悬挂）。
   * 已应用建议（meta.baseline 存在且未回滚）→ 对比基线：劣化（avgFails/avgSteps 升 50%+）→
   * 从目标资产移除规则 stamp + 建议状态 rolled_back + 落回滚 insight；未劣化 → verified。
   */
  private async checkDeopt(): Promise<void> {
    const mem = this.deps.memory!;
    const rows = await mem.queryReadOnly!(
      `SELECT id, tenant_id, content, meta FROM memory_entries WHERE kind = 'optimizer-suggestion' AND status = 'official' AND meta->>'baseline' IS NOT NULL AND meta->>'rolledBack' IS NULL`,
    ) as Array<{ id: string; tenant_id?: string; content: string; meta: Record<string, unknown> }>;
    for (const row of rows) {
      try {
        const suggestionTenantId = row.tenant_id ?? DEFAULT_TENANT_ID;
        const sug = (typeof row.content === "string" ? JSON.parse(row.content) : row.content) as OptimizerSuggestion;
        const target = sug.target;
        const pattern = sug.evidence?.pattern ?? "rule";
        const roleId = target.startsWith("role-doc:") ? target.slice("role-doc:".length) : undefined;
        const baseline = row.meta?.["baseline"] as { avgFails: number; avgSteps: number; taskCount: number; avgGuardKills?: number; avgGuardHits?: number } | undefined;
        if (!baseline) continue;

        // A4 护栏 JIT（2026-08-18）：guard-config 建议走全局聚合通道（无单一角色/无复测任务），
        // 劣化判定 avgKills 升 50%+ 或 avgHits 跌破 50%——劣化则回滚运行时参数原值。
        if (target.startsWith("guard-config:")) {
          const g = await this.readGlobalAgg();
          if (g?.taskCount && g.taskCount - baseline.taskCount >= this.windowSize) {
            const avgKills = (g.sumGuardKills ?? 0) / g.taskCount;
            const avgHits = (g.sumGuardHits ?? 0) / g.taskCount;
            const worse = avgKills > (baseline.avgGuardKills ?? 0) * 1.5 + 0.001 || avgHits < (baseline.avgGuardHits ?? 0) * 0.5;
            if (!worse) {
              await mem.update!(row.id, { meta: { ...row.meta, verifyAfterWindow: false, verifiedAt: Date.now(), verifySource: "global" } } as never, { tenantId: suggestionTenantId });
              continue;
            }
            const guardBaseline = row.meta?.["guardBaseline"] as { limitKey?: string; from?: string; to?: string; values?: Record<string, string> } | undefined;
            const limitKey = guardBaseline?.limitKey ?? sug.guard?.limitKey;
            const original = (limitKey && guardBaseline?.values?.[limitKey]) ?? guardBaseline?.from;
            if (limitKey && original !== undefined) {
              const runtimeConfig = this.deps.runtimeConfig ?? config();
              runtimeConfig.set(limitKey, original);
            }
            const guardId = target.slice("guard-config:".length);
            await mem.update!(row.id, {
              status: "rolled_back",
              meta: { ...row.meta, rolledBack: true, rolledBackAt: Date.now(), verifySource: "global", rollbackReason: `护栏参数放宽后劣化（avgGuardKills ${(baseline.avgGuardKills ?? 0).toFixed(2)}→${avgKills.toFixed(2)} / avgGuardHits ${(baseline.avgGuardHits ?? 0).toFixed(2)}→${avgHits.toFixed(2)}——证据: global）` },
            } as never, { tenantId: suggestionTenantId });
            const guardDeoptContent = JSON.stringify({
              type: "guard-deopt", suggestionId: row.id, pattern, target, guard: guardId, source: "global",
              baseline: { avgGuardKills: baseline.avgGuardKills ?? 0, avgGuardHits: baseline.avgGuardHits ?? 0 },
              current: { avgKills, avgHits }, rolledBackAt: Date.now(),
              note: "护栏参数放宽后误杀恶化/命中面消失——已自动回滚原值（deopt 刹车）",
            });
            void mem.write({
              kind: "task-insight",
              tenantId: DEFAULT_TENANT_ID,
              anchors: ["guard-deopt", pattern, guardId],
              content: guardDeoptContent,
              status: "official",
              meta: deoptInsightMeta(guardDeoptContent, row.id, { pattern, guard: guardId, ts: Date.now() }),
            }).catch(() => { /* 回滚 insight 落库失败不阻塞 */ });
            console.warn(`[optimizer] guard deopt 回滚: ${pattern}（${guardId}——avgKills ${(baseline.avgGuardKills ?? 0).toFixed(2)}→${avgKills.toFixed(2)} / avgHits ${(baseline.avgGuardHits ?? 0).toFixed(2)}→${avgHits.toFixed(2)}——global）`);
          }
          continue;
        }

        // ── 复测证据（N6 一等化——三通道：独立复测任务 > 角色有机流量 > 全局聚合）──
        const v = await this.readVerifyAgg(row.id);
        let evidence: { avgFails: number; avgSteps: number; source: string } | null = null;
        if (v && (v.taskCount ?? 0) >= this.verifyTasksCount) {
          evidence = { avgFails: (v.sumFails ?? 0) / v.taskCount, avgSteps: (v.sumSteps ?? 0) / v.taskCount, source: "verify-task" };
        } else if (roleId) {
          const a = await this.readRoleAgg(roleId);
          if (a?.taskCount && a.taskCount - baseline.taskCount >= this.windowSize) {
            evidence = { avgFails: (a.sumFails ?? 0) / a.taskCount, avgSteps: (a.sumSteps ?? 0) / a.taskCount, source: "organic" };
          }
        } else {
          const g = await this.readGlobalAgg();
          if (g?.taskCount && g.taskCount - baseline.taskCount >= this.windowSize) {
            evidence = { avgFails: (g.sumFails ?? 0) / g.taskCount, avgSteps: (g.sumSteps ?? 0) / g.taskCount, source: "global" };
          }
        }

        if (!evidence) {
          // 超时未闭合（N6：verify 必须闭合——诚实缺口可见而非静默悬挂）
          const appliedAt = Number(row.meta?.["appliedAt"] ?? 0);
          if (appliedAt && Date.now() - appliedAt > this.verifyTimeoutMs) {
            const progressed = (v?.taskCount ?? 0) > 0 || (roleId ? ((await this.readRoleAgg(roleId))?.taskCount ?? 0) > baseline.taskCount : false);
            if (!progressed) {
              await mem.update!(row.id, { meta: { ...row.meta, verifyAfterWindow: false, verifyExpired: true, expiredAt: Date.now(), expiryReason: "verify 超时零进展——复测证据未积累（无复测任务完成/无有机流量），验证未闭合需人工复核" } } as never, { tenantId: suggestionTenantId });
              const expiredContent = JSON.stringify({ type: "verify-expired", suggestionId: row.id, pattern, target, note: "应用后复测超时零证据——已标记 verify_expired（诚实缺口——人工复核或降级人工闸门）" });
              void mem.write({
                kind: "task-insight",
                tenantId: DEFAULT_TENANT_ID,
                anchors: ["verify-expired", pattern, roleId ?? "capability-index"],
                content: expiredContent,
                status: "official",
                meta: deoptInsightMeta(expiredContent, row.id, { pattern, ts: Date.now() }),
              }).catch(() => { /* 洞察落库失败不阻塞 */ });
              console.warn(`[optimizer] verify 超时未闭合: ${row.id}（${pattern}——${target}）`);
            }
          }
          continue;
        }

        const worse = evidence.avgFails > baseline.avgFails * 1.5 || evidence.avgSteps > baseline.avgSteps * 1.5;
        if (!worse) {
          // 指标未劣化——规则有效——验证闭合（verified）
          await mem.update!(row.id, { meta: { ...row.meta, verifyAfterWindow: false, verifiedAt: Date.now(), verifySource: evidence.source } } as never, { tenantId: suggestionTenantId });
          continue;
        }
        // 回滚：从目标资产移除该 pattern 的规则 stamp
        const doc = await mem.queryReadOnly!(`SELECT content, tenant_id FROM memory_entries WHERE id = '${target}'`) as Array<{ content: string; tenant_id?: string }>;
        const docTenantId = doc[0]?.tenant_id ?? DEFAULT_TENANT_ID;
        const docContent = String(doc[0]?.content ?? "");
        const stampRe = new RegExp(`\n\n【优化规则 · ${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\n]*】\n- [^\n]*`);
        const cleaned = docContent.replace(stampRe, "");
        if (cleaned !== docContent) {
          await mem.update!(target, { content: cleaned }, { tenantId: docTenantId });
        }
        await mem.update!(row.id, {
          status: "rolled_back",
          meta: { ...row.meta, rolledBack: true, rolledBackAt: Date.now(), verifySource: evidence.source, rollbackReason: `指标劣化（avgFails ${baseline.avgFails.toFixed(2)}→${evidence.avgFails.toFixed(2)} / avgSteps ${baseline.avgSteps.toFixed(1)}→${evidence.avgSteps.toFixed(1)}——证据: ${evidence.source}）` },
        } as never, { tenantId: suggestionTenantId });
        const deoptContent = JSON.stringify({
          type: "deopt-rollback", pattern, target, roleId, source: evidence.source,
          baseline, current: { avgFails: evidence.avgFails, avgSteps: evidence.avgSteps }, rolledBackAt: Date.now(),
          note: "优化规则应用后指标劣化——已自动回滚（deopt 刹车——不优于基线即撤）",
        });
        void mem.write({
          kind: "task-insight",
          tenantId: DEFAULT_TENANT_ID,
          anchors: ["deopt", pattern, roleId ?? "capability-index"],
          content: deoptContent,
          status: "official",
          meta: deoptInsightMeta(deoptContent, row.id, { pattern, role: roleId, ts: Date.now() }),
        }).catch(() => { /* 回滚 insight 落库失败不阻塞 */ });
        console.warn(`[optimizer] deopt 回滚: ${pattern}（${roleId ?? "capability-index"}——基线 ${baseline.avgFails.toFixed(2)}→${evidence.avgFails.toFixed(2)} fails——${evidence.source}）`);
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
