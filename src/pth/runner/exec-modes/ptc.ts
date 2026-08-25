/**
 * runner/exec-modes/ptc.ts —— PTH_EXEC_MODE=ptc 的迭代模式执行。
 */
import { TASK_AWAIT_SUSPENDED_CODE } from "@away_from/pth-contracts";
import { runPtcAgentTask, type AgentTraceEvent } from "@away_from/pth-kernel-execution";
import type { TaskOutcome, TaskSuspension } from "@away_from/pth-contracts";
import { buildTaskCapabilityInject } from "./task-capability-inject.js";
import type { ExecModeContext } from "./types.js";

export async function runPtcMode(ctx: ExecModeContext): Promise<TaskOutcome | TaskSuspension> {
  const { deps, lease, work, traceId, ref, aborted } = ctx;
  if (!deps.llm) {
    return {
      lease: ref,
      status: "rejected",
      retryable: false,
      error: { code: "no-llm", message: "PTH_EXEC_MODE=ptc 需要 llm" },
      artifacts: [],
      traceId,
    };
  }
  const traceEvents: AgentTraceEvent[] = [];
  const workPayload = (work.payload ?? {}) as {
    delivery?: { goal?: unknown };
    pauseAnswer?: { answer?: unknown; answeredBy?: unknown; answeredAt?: unknown };
  };
  const goal = typeof workPayload.delivery?.goal === "string" && workPayload.delivery.goal.trim() !== ""
    ? workPayload.delivery.goal
    : undefined;
  const pauseAnswer = workPayload.pauseAnswer;
  const publisherClarification = pauseAnswer && typeof pauseAnswer.answer === "string" && pauseAnswer.answer.trim() !== ""
    ? `（${typeof pauseAnswer.answeredBy === "string" && pauseAnswer.answeredBy !== "" ? pauseAnswer.answeredBy : "发布者"}）: ${pauseAnswer.answer.trim()}`
    : undefined;
  const r = await runPtcAgentTask({
    llm: deps.llm,
    kernel: deps.kernel,
    task: { title: work.title, text: work.text },
    ...(goal ? { goal } : {}),
    ...(publisherClarification ? { publisherClarification } : {}),
    taskWorkspace: deps.workspace.dir,
    capabilityInject: buildTaskCapabilityInject({
      kernel: deps.kernel,
      taskWorkspace: deps.workspace.dir,
      toolstore: (deps.kernel as unknown as { toolstore?: import("@away_from/pth-kernel-interpreter").Toolstore }).toolstore,
      roleCapabilities: deps.role.capabilities,
      base: deps.caps,
      ...(deps.networkExecuteFactory
        ? { networkExecute: deps.networkExecuteFactory({ taskId: lease.taskId, tenantId: work.scope.tenantId, roleId: deps.role.id }) }
        : deps.networkExecute ? { networkExecute: deps.networkExecute } : {}),
    }),
    allowedCapabilities: deps.role.capabilities ? new Set(deps.role.capabilities) : undefined,
    logger: deps.logger,
    onTrace: (e) => {
      traceEvents.push(e);
      deps.onTrace?.(e);
    },
  });
  if (aborted()) {
    return { lease: ref, status: "cancelled", retryable: true, error: { code: "cancelled", message: "cancelled during ptc execution" }, artifacts: [], traceId };
  }
  if (r.ok && r.code === TASK_AWAIT_SUSPENDED_CODE) {
    return {
      lease: ref,
      status: "rejected",
      retryable: true,
      error: { code: TASK_AWAIT_SUSPENDED_CODE, message: r.warning ?? "task-await-suspended" },
      artifacts: [],
      traceId,
    };
  }
  if (!r.ok) {
    return { lease: ref, status: "rejected", retryable: false, error: { code: "ptc-failed", message: r.error }, artifacts: [], traceId };
  }
  if (r.value === undefined || r.value === null) {
    if (r.warning) {
      return { lease: ref, status: "rejected", retryable: true, error: { code: "soft-terminated", message: r.warning }, artifacts: [], traceId };
    }
    return { lease: ref, status: "rejected", retryable: false, error: { code: "ptc-no-output", message: "PTC 完成但未产出结果" }, artifacts: [], traceId };
  }
  return {
    lease: ref,
    status: "completed",
    result: { value: r.value, summary: r.summary ?? "", steps: r.steps },
    artifacts: [],
    traceId,
  };
}
