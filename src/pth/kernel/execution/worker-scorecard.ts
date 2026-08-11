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
  /** token 消耗汇总 */
  tokens: { input: number; output: number };
  /** 失败动作数（tool-result ok:false） */
  failedActions: number;
  /** ASP 门控命中数（空间门控/done 门控——协议学习成本指标） */
  gatedActions: number;
  /** ASP 导航使用（cd/index 次数——协议采纳度指标） */
  aspNav: { cds: number; indexes: number };
  /** 完成状态与警告（maxSteps/重复终止等） */
  finish?: { ok: boolean; warning?: string };
}

export function buildScorecard(events: AgentTraceEvent[]): WorkerScorecard {
  const sc: WorkerScorecard = {
    steps: 0,
    toolFreq: {},
    tokens: { input: 0, output: 0 },
    failedActions: 0,
    gatedActions: 0,
    aspNav: { cds: 0, indexes: 0 },
  };
  for (const e of events) {
    if (e.type === "llm-call") {
      if (e.usage) {
        sc.tokens.input += e.usage.inputTokens ?? 0;
        sc.tokens.output += e.usage.outputTokens ?? 0;
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
