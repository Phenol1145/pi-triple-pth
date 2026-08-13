/**
 * worker-scorecard —— worker 性能记分卡（2026-08-10——评估层：压缩产物的读者）。
 *
 * 数据源：transcripts 的 trace 事件流（llm-call 带 usage / tool-call / tool-result 带 ok+duration）。
 * 轻聚合（不读全量内容——全量分析由压缩产物承担）。
 *
 * 指标：
 *   - 工具调用频率分布（toolFreq）
 *   - token 消耗（input/output 汇总——llm-call.usage）
 *   - 失败动作 / 门控命中 / ASP 导航（cd/index 使用）
 */

import type { AgentTraceEvent } from "./agent-loop.js";

export interface WorkerScorecard {
  steps: number;
  /** 工具调用频率（tool → 次数） */
  toolFreq: Record<string, number>;
  /** token 消耗汇总（cacheRead/cacheWrite = prompt 缓存命中/写入——2026-08-12 用户问询补齐；
   *  cacheHitRate = cacheRead / (cacheRead + 非缓存输入)——token 缓存命中率观测） */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** 失败动作数（tool-result ok:false） */
  failedActions: number;
  /** ASP 门控命中数（空间门控/done 门控——协议学习成本指标） */
  gatedActions: number;
  /** ASP 导航使用（cd/index 次数——协议采纳度指标） */
  aspNav: { cds: number; indexes: number };
  /** 时间复用率（planner 计划扁平度——2026-08-13：关键路径法 1-关键路径/总数；非 planner 任务 null） */
  timeReuse?: number | null;
  /** 完成状态与警告（maxSteps/重复终止等） */
  finish?: { ok: boolean; warning?: string };
}

/**
 * 时间复用率（用户 2026-08-13 监测量——planner 计划扁平化）。
 * 关键路径法：DAG 最长路（任务数计）→ 复用率 = 1 - 关键路径/总数。
 *   全并行（互不依赖）：关键路径 1 → 复用率 (n-1)/n
 *   全串行（链式依赖）：关键路径 n → 复用率 0
 * 无依赖标注（缺 dependsOn）视为可并行；单任务/无 subtasks 返回 null（无复用概念）。
 */
export function computeTimeReuse(subtasks: Array<{ id?: string; dependsOn?: string[] }> | undefined): number | null {
  if (!Array.isArray(subtasks) || subtasks.length < 2) return null;
  const n = subtasks.length;
  const idx = new Map<string, number>(subtasks.map((s, i) => [String(s.id ?? `s${i}`), i]));
  const adj: number[][] = subtasks.map(() => []);
  for (const [i, s] of subtasks.entries()) {
    for (const d of s.dependsOn ?? []) {
      const j = idx.get(d);
      if (j !== undefined && j !== i) adj[j]!.push(i);
    }
  }
  const memo: number[] = new Array(n).fill(-1);
  const longest = (i: number): number => {
    if (memo[i]! >= 0) return memo[i]!;
    let best = 1;
    for (const j of adj[i]!) best = Math.max(best, 1 + longest(j));
    return (memo[i] = best);
  };
  const crit = Math.max(...subtasks.map((_, i) => longest(i)));
  return Math.round((1 - crit / n) * 100) / 100;
}

export function buildScorecard(events: AgentTraceEvent[]): WorkerScorecard {
  const sc: WorkerScorecard = {
    steps: 0,
    toolFreq: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    failedActions: 0,
    gatedActions: 0,
    aspNav: { cds: 0, indexes: 0 },
  };
  for (const e of events) {
    if (e.type === "llm-call") {
      if (e.usage) {
        sc.tokens.input += e.usage.inputTokens ?? 0;
        sc.tokens.output += e.usage.outputTokens ?? 0;
        sc.tokens.cacheRead += e.usage.cacheReadTokens ?? 0;
        sc.tokens.cacheWrite += e.usage.cacheWriteTokens ?? 0;
      }
    } else if (e.type === "tool-call") {
      sc.toolFreq[e.tool] = (sc.toolFreq[e.tool] ?? 0) + 1;
      if (e.tool === "asp_cd") sc.aspNav.cds++;
      if (e.tool === "asp_index" || e.tool === "memory_index") sc.aspNav.indexes++;
    } else if (e.type === "tool-result") {
      if (!e.ok) {
        sc.failedActions++;
        if (e.resultPreview.includes("门控")) sc.gatedActions++;
      }
    } else if (e.type === "finish") {
      sc.steps = e.steps;
      sc.finish = { ok: e.ok, ...(e.warning ? { warning: e.warning } : {}) };
    }
  }
  return sc;
}
