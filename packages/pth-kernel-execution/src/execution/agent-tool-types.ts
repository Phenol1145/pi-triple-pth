/**
 * agent-tool-types.ts —— AgentToolResult 共享类型（TCE W1/W2：能力对象与 AGENT_TOOLS 共用）。
 *
 * 独立成文件避免 capabilities/registry 之间的类型环（static-all SCC）。
 */

import type { CommandFeedback } from "./command-feedback.js";

export interface AgentToolResult {
  ok: boolean;
  value?: unknown;
  stdout?: string;
  stderr?: string;
  error?: string;
  /** interpreter 错误码透传（W8 P2：task-await-suspended 挂起信号） */
  code?: string;
  truncated?: boolean;
  /** 输出模式标记（quiet 时轨迹记 [quiet]——agent-loop 用） */
  quiet?: boolean;
  /** TCE P3：await-approval 的 human request id（code=HUMAN_APPROVAL_PENDING 时携带） */
  requestId?: string;
  /** TCE Wave 2：结构化 Command/Execute 错误反馈（可选——旧消费方不读也能继续工作） */
  feedback?: CommandFeedback;
  /** TCE Wave 2：工具执行耗时（ms） */
  durationMs?: number;
}
