/**
 * agent-loop-step.ts —— agent 循环工具步公共输出助手。
 *
 * 收敛 `agent-loop.ts` 与 `agent-loop-registry-execution.ts` 中重复的
 * onStep / summary / tool-message 三段式输出逻辑。
 */
import type { AgentLoopOptions, AgentTaskInput } from "./agent-loop-types.js";
import type { AgentToolResult } from "./agent-tools.js";

export type AgentLoopMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  thinking?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
};

export interface EmitToolStepOptions {
  input: AgentTaskInput & AgentLoopOptions;
  messages: AgentLoopMessage[];
  tool: string;
  args: Record<string, unknown>;
  result: AgentToolResult;
  steps: number;
  toolCallId?: string;
  durationMs: number;
  /** 错误摘要回退到 stderr（部分执行器 error 为空但 stderr 有内容） */
  includeStderr?: boolean;
  /** 覆盖成功摘要（如 quiet 模式） */
  quietSummary?: string;
  /** 追加在 tool 消息末尾（如 truncated/收敛引导） */
  suffix?: string;
}

export function toolStepSummary(result: AgentToolResult, includeStderr = false): string {
  if (result.quiet) return "[quiet] 静默执行（无输出）";
  if (result.ok) return (result.stdout ?? JSON.stringify(result.value ?? null)).slice(0, 500);
  return `error: ${result.error ?? (includeStderr && result.stderr?.trim() ? result.stderr : "unknown")}`;
}

export function emitToolStep(opts: EmitToolStepOptions): void {
  const { input, messages, tool, args, result, steps, toolCallId, durationMs } = opts;
  input.onStep?.({
    n: steps + 1,
    tool,
    durationMs,
    ok: result.ok,
    args: JSON.stringify(args).slice(0, 300),
  });
  const summary = opts.quietSummary ?? toolStepSummary(result, opts.includeStderr);
  messages.push({
    role: "tool",
    toolCallId: toolCallId ?? `tc-${steps + 1}`,
    toolName: tool,
    content: `step ${steps + 1} [${tool}]: ${summary}${opts.suffix ?? ""}`,
  });
}
