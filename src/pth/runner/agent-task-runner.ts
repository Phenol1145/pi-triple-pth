/**
 * runner/agent-task-runner.ts — 纯任务执行器（模块化 v2 P1-4）。
 *
 * 只收 { lease, work }，产出 TaskOutcome；不调用 repository/audit/transcript/notify，
 * 也不做 workspace 分配/归档——这些副作用全部属于调度层。
 *
 * 执行路径（与 task-loop 原有语义一致）：
 *  - await kernel.reset() 完成后才开始执行（reset 为异步实现时也等待）；
 *  - PTH_EXEC_MODE=ptc → runner/exec-modes/ptc.ts；
 *  - tool-call / asp → runner/exec-modes/llm-agent.ts；
 *  - 其他 llm 路径 → runner/exec-modes/pulse.ts；
 *  - 无 llm → rejected（任务池只面向自然语言）；
 *  - 取消信号：进入前 aborted 直接 cancelled；运行中 aborted 触发 kernel.abort()。
 */

import type { TaskLease, TaskOutcome, TaskRunner, TaskSuspension, TaskWorkItem } from "@away_from/pth-contracts";
import { defaultRunnerConfig, type RunnerConfig } from "./runner-config.js";
import type { AgentTaskRunnerDeps } from "./exec-modes/types.js";
export type { AgentTaskRunnerDeps } from "./exec-modes/types.js";
import { runPtcMode } from "./exec-modes/ptc.js";
import { runLlmAgentMode } from "./exec-modes/llm-agent.js";
import { runPulseMode } from "./exec-modes/pulse.js";

function leaseRef(lease: TaskLease): TaskOutcome["lease"] {
  return { taskId: lease.taskId, leaseId: lease.leaseId, generation: lease.generation };
}

export class AgentTaskRunner implements TaskRunner {
  constructor(private deps: AgentTaskRunnerDeps) {}

  async run(input: { lease: TaskLease; work: TaskWorkItem; signal?: AbortSignal }): Promise<TaskOutcome | TaskSuspension> {
    const { lease, work, signal } = input;
    const config = { ...defaultRunnerConfig(), ...this.deps.config };
    const traceId = work.scope.traceId;

    if (signal?.aborted) {
      return { lease: leaseRef(lease), status: "cancelled", retryable: true, error: { code: "cancelled", message: "cancelled before execution" }, artifacts: [], traceId };
    }

    // 任务级状态隔离：reset 异步实现也等待完成（审计 P1-2）
    await this.deps.kernel.reset();

    // 运行中取消：触发程序级制动（kernel.abort 终止 in-flight），结果以 cancelled 收口
    let aborted = signal?.aborted ?? false;
    const onAbort = () => {
      aborted = true;
      void this.deps.kernel.abort?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const outcome = await this.executeInner(lease, work, config, traceId, () => aborted);
      if (!("status" in outcome)) return outcome;
      if (aborted && outcome.status !== "cancelled") {
        return { lease: leaseRef(lease), status: "cancelled", retryable: true, error: { code: "cancelled", message: "cancelled during execution" }, artifacts: [], traceId };
      }
      return outcome;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async executeInner(
    lease: TaskLease,
    work: TaskWorkItem,
    config: RunnerConfig,
    traceId: string,
    aborted: () => boolean,
  ): Promise<TaskOutcome | TaskSuspension> {
    const { llm, caps } = this.deps;
    const ref = leaseRef(lease);
    const ctx = { deps: this.deps, lease, work, config, traceId, ref, aborted };

    // Wave 5：ptc 迭代模式。
    if (config.execMode === "ptc") {
      return runPtcMode(ctx);
    }

    // 显式 tool-call/asp 缺少必需能力 → fail-closed；legacy/default 走既有降级/无 llm 路径。
    if ((config.execMode === "tool-call" || config.execMode === "asp") && (!llm || !caps) && config.execModeExplicit) {
      return {
        lease: ref,
        status: "rejected",
        retryable: false,
        error: {
          code: "exec-mode-capability-missing",
          message: `PTH_EXEC_MODE=${config.execMode} 需要 llm+agentCaps（llm=${Boolean(llm)} caps=${Boolean(caps)}）——显式模式 fail-closed`,
        },
        artifacts: [],
        traceId,
      };
    }

    if ((config.execMode === "tool-call" || config.execMode === "asp") && llm && caps) {
      return runLlmAgentMode(ctx);
    }

    if (llm) {
      return runPulseMode(ctx);
    }

    return {
      lease: ref,
      status: "rejected",
      retryable: false,
      error: { code: "no-llm", message: "任务池为自然语言池（agent/translate 均需 LLM）——直连执行请走 /kernel/exec 通道" },
      artifacts: [],
      traceId,
    };
  }
}
