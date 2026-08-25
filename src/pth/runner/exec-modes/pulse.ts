/**
 * runner/exec-modes/pulse.ts —— pulse（translate + runPtcProgram）执行路径。
 */
import { TASK_AWAIT_SUSPENDED_CODE } from "@away_from/pth-contracts";
import { translateTask, type AgentTraceEvent } from "@away_from/pth-kernel-execution";
import { runPtcProgram } from "@away_from/pth-kernel-interpreter";
import type { TaskOutcome, TaskSuspension } from "@away_from/pth-contracts";
import type { ExecModeContext } from "./types.js";

export async function runPulseMode(ctx: ExecModeContext): Promise<TaskOutcome | TaskSuspension> {
  const { deps, lease, work, traceId, ref, aborted } = ctx;
  // Wave 4：pulse 是一等模式——translate/result 事件写入 trace/transcript。
  const traceEvents: AgentTraceEvent[] = [];
  const tStart = Date.now();
  const t = await translateTask({ llm: deps.llm! }, { title: work.title, text: work.text });
  const translateEvent: AgentTraceEvent = t.ok
    ? { type: "pulse-translate", step: 0, ok: true, codeLength: t.code.length }
    : { type: "pulse-translate", step: 0, ok: false, error: t.error };
  traceEvents.push(translateEvent);
  deps.onTrace?.(translateEvent);
  if (aborted()) {
    return { lease: ref, status: "cancelled", retryable: true, error: { code: "cancelled", message: "cancelled during translation" }, artifacts: [], traceId };
  }
  if (!t.ok) {
    return { lease: ref, status: "rejected", retryable: false, error: { code: "nl-translate-failed", message: t.error }, artifacts: [], traceId };
  }
  const raw = (await runPtcProgram({ code: t.code, cwd: deps.workspace.dir, ts: deps.kernel.ts })).raw;
  const resultEvent: AgentTraceEvent = {
    type: "pulse-result",
    step: 0,
    ok: raw.ok,
    ...(raw.ok ? { valuePreview: JSON.stringify(raw.value ?? null).slice(0, 200) } : { error: raw.error?.message ?? "unknown" }),
    code: t.code,
    durationMs: Date.now() - tStart,
  };
  traceEvents.push(resultEvent);
  deps.onTrace?.(resultEvent);
  if (aborted()) {
    return { lease: ref, status: "cancelled", retryable: true, error: { code: "cancelled", message: "cancelled during ptc execution" }, artifacts: [], traceId };
  }
  if (!raw.ok) {
    // W8 P2：tasks.await 挂起信号 → retryable requeue（释放认领；子终态事件触发重跑）
    if (raw.error?.code === TASK_AWAIT_SUSPENDED_CODE) {
      return {
        lease: ref,
        status: "rejected",
        retryable: true,
        error: { code: TASK_AWAIT_SUSPENDED_CODE, message: raw.error.message },
        result: raw,
        artifacts: [],
        traceId,
      };
    }
    return {
      lease: ref,
      status: "rejected",
      retryable: false,
      error: { code: "execution-failed", message: raw.error?.message ?? "unknown execution error" },
      result: raw,
      artifacts: [],
      traceId,
    };
  }
  return { lease: ref, status: "completed", result: raw, artifacts: [], traceId };
}
