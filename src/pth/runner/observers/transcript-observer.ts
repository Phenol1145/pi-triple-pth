/**
 * runner/observers/transcript-observer.ts — 轨迹持久化 fan-out（模块化 v2 P1-7）。
 *
 * 只消费 context.traceEvents；无轨迹（PTC fast-path）则零写入。
 * tenantId 随 work.scope 持久化。
 * 2026-08-25 W-d：context.contextSnapshots（agent-loop 采集的上下文快照）随同行落盘
 * ——受 PTH_TRANSCRIPT_CONTEXT_MAX_CHARS 字符上限约束（超限按快照从旧到新丢弃，始终保留 final）。
 */

import { pthConfig } from "@away_from/pth-config";
import type { TaskOutcomeObserverFn } from "../../tasking/index.js";

export interface TranscriptObserverDeps {
  create(input: {
    taskId?: string;
    agentId: string;
    body: unknown[];
    summary?: string;
    tenantId?: string;
    /** 任务上下文快照（transcripts.context 列） */
    context?: unknown;
  }): Promise<unknown>;
}

/** 上下文快照有界化：整包 → 只留 final → final 内逐消息截断 → 硬截断（标记 truncated） */
function boundContext(payload: unknown, maxChars: number): unknown {
  const fits = (v: unknown): boolean => JSON.stringify(v).length <= maxChars;
  if (fits(payload)) return payload;
  const cap = payload as { system?: string; snapshots?: Array<{ reason?: string; messages?: Array<{ content?: unknown }> }> };
  const snapshots = Array.isArray(cap.snapshots) ? cap.snapshots : [];
  const finalOnly = snapshots.filter((s) => s?.reason === "final");
  const keep = finalOnly.length > 0 ? finalOnly : snapshots.slice(-1);
  const level2 = { ...cap, snapshots: keep, truncated: true };
  if (fits(level2)) return level2;
  const level3 = {
    ...level2,
    snapshots: keep.map((s) => ({
      ...s,
      messages: (s.messages ?? []).map((m) => ({
                    ...m,
                    content: typeof m.content === "string" && m.content.length > 2000 ? m.content.slice(0, 2000) + "…(截断)" : m.content,
                  })),
    })),
  };
  if (fits(level3)) return level3;
  return { truncated: true, note: "超出 PTH_TRANSCRIPT_CONTEXT_MAX_CHARS，硬截断", head: JSON.stringify(level3).slice(0, maxChars) };
}

export function createTranscriptObserver(deps: TranscriptObserverDeps): TaskOutcomeObserverFn {
  return async (event) => {
    const trace = event.context?.["traceEvents"];
    if (!Array.isArray(trace) || trace.length === 0) return;
    const result = event.outcome.result as { summary?: string; value?: unknown } | undefined;
    const summary =
      event.outcome.status === "completed"
        ? (result?.summary ?? (result?.value !== undefined && result?.value !== null ? JSON.stringify(result.value).slice(0, 200) : ""))
        : (event.outcome.error?.message ?? "").slice(0, 200);
    const snapshots = event.context?.["contextSnapshots"];
    const context = Array.isArray(snapshots) && snapshots.length > 0
      ? boundContext(snapshots[0], pthConfig().num("PTH_TRANSCRIPT_CONTEXT_MAX_CHARS", 500_000))
      : undefined;
    await deps.create({
      taskId: event.work.taskId,
      agentId: event.work.assignedRole,
      body: trace,
      summary,
      tenantId: event.work.scope.tenantId,
      ...(context !== undefined ? { context } : {}),
    });
  };
}
