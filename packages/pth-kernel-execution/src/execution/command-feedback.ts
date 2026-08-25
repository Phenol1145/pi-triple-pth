/**
 * command-feedback.ts —— Command/Execute 层的结构化错误反馈（Wave 2）。
 *
 * CommandFeedback 进入 AgentToolResult 作为可选字段，供 trace/scorecard/TCE 观测消费。
 * `await-approval` 不是错误反馈，不进入本类型；它继续映射为
 * HUMAN_APPROVAL_PENDING + TaskSuspension。
 */

import type { CommandErrorClass } from "./optimization-loop-spec.js";

export type { CommandErrorClass };

export interface CommandFeedback {
  readonly layer: "command" | "execute";
  readonly class: CommandErrorClass;
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly adapterId?: string;
  readonly execKind?: "language" | "external" | "internal" | "agent";
  readonly target?: string;
  readonly errorClass?: string;
  readonly errorCode?: string;
  readonly durationMs?: number;
}

export function commandFeedback(input: CommandFeedback): CommandFeedback {
  return input;
}

/** Tool 层/Execute 层内部统一结果信封（canonical）；AgentToolResult 是其 agent-loop 投影。 */
export interface ToolOutcome {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
  readonly code?: string;
  readonly truncated?: boolean;
  readonly feedback?: CommandFeedback;
  readonly durationMs?: number;
}
