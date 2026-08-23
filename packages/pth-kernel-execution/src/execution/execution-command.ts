/**
 * execution-command.ts —— 三层执行面模型的 Command 层/Execute 层契约。
 *
 * 职责边界：
 *  - Tool 层：只描述 tool call（见 PTC_TOOL_DEFS / AGENT_TOOLS schema）。
 *  - Command 层：把 tool call 翻译成 ExecutionCommand，并完成权限审查/目标选择。
 *  - Execute 层：只消费 ExecutionCommand，按 target/binding 路由到具体执行后端。
 *
 * 本文件只定义类型与接口，不 import 任何 backend/kernel 实现。
 */

import type { NotebookLanguage } from "@away_from/pth-contracts";

/** 执行范围：任务级会话 / notebook 级会话 / 一次性无状态。 */
export type ExecutionScope = "task" | "notebook" | "stateless";

/** 安全上下文：Command 层从调用方（agent-loop / notebook API）盖章，Execute 层透传审计。 */
export interface CommandSecurityContext {
  readonly principalId: string;
  readonly tenantId: string;
  readonly roleId: string;
  readonly space?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly approval?: { readonly ref: string; readonly decision: "approved" };
}

/** 三层之间的 tool call 表示（Tool 层产物，Command 层输入）。 */
export interface ToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** notebook cell 输入（Command 层输入的一种）。 */
export interface NotebookCellInput {
  readonly language: NotebookLanguage;
  readonly code: string;
  readonly target?: string | null;
  readonly sessionId?: string;
  readonly timeoutMs?: number;
}

/** Command 层输入（入口归一）。 */
export type CommandInput =
  | {
      readonly surface: "agent-tool";
      readonly toolCall: ToolCall;
      readonly ctx: CommandSecurityContext;
    }
  | {
      readonly surface: "notebook";
      readonly cell: NotebookCellInput;
      readonly ctx: CommandSecurityContext;
    };

/**
 * Command 层输出（三态——批准是异步的，二态 ok/not-ok 表达不了“等人工”）。
 * `execute.command.target` 必须已被 Command 层解析为具体 id（Execute 层不再做默认路由）。
 */
export type CommandDecision =
  | { readonly kind: "execute"; readonly command: ExecutionCommand }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "await-approval"; readonly requestId: string; readonly command: ExecutionCommand };

/** Command 层入口端口：翻译 + 目标决策 + 权限审查。 */
export interface CommandGateway {
  decide(input: CommandInput): Promise<CommandDecision>;
}

/** 人类批准端口（进程内适配 PgHumanInteractionService；不新建审批存储/API）。 */
export interface HumanApprovalGateway {
  requestApproval(input: {
    readonly command: ExecutionCommand;
    readonly ctx: CommandSecurityContext;
    readonly fingerprint: string;
  }): Promise<{ readonly requestId: string }>;
  verifyApproval(input: {
    readonly command: ExecutionCommand;
    readonly ctx: CommandSecurityContext;
    readonly fingerprint: string;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
}

/** Command 公共字段。 */
export interface ExecutionCommandBase {
  /** 命令实例 id（审计/追踪）。 */
  readonly id: string;
  /** 来源 tool 名。 */
  readonly tool: string;
  readonly scope: ExecutionScope;
  readonly security: CommandSecurityContext;
  /** Command 层解析后的具体 target id；Execute 层不再做默认路由（internal 可缺省）。 */
  readonly target?: string | null;
  readonly timeoutMs?: number;
}

/**
 * 规范化 Command（Command 层产物，Execute 层输入）。
 *
 * - language：ts/python/bash 代码执行（可路由到 sandbox / engine-ts / command target）。
 * - external：argv 白名单命令（tool-container 专用；也兼容 local/tool 的 argv 形式）。
 * - internal：进程内能力调用（memory/cache/asp 等），不经过外部执行后端。
 */
export type ExecutionCommand =
  | (ExecutionCommandBase & {
      readonly kind: "language";
      readonly language: NotebookLanguage;
      readonly code: string;
      readonly mode?: "single" | "program";
      readonly sessionId?: string | null;
      readonly space?: string;
      readonly taskWorkspace?: string;
      readonly caps?: Readonly<Record<string, unknown>>;
    })
  | (ExecutionCommandBase & {
      readonly kind: "external";
      readonly argv: readonly string[];
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly maxOutputBytes?: number;
    })
  | (ExecutionCommandBase & {
      readonly kind: "internal";
      readonly capability: string;
      readonly args: Readonly<Record<string, unknown>>;
    });

/** Execute 层统一结果（中间表示；Tool 层再投影成 AgentToolResult / NotebookCellResult）。 */
export interface ExecutionResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: { readonly message: string; readonly code?: string };
  readonly durationMs: number;
  /** 实际命中的 target id（观测/审计）。 */
  readonly target?: string;
  readonly sessionId?: string;
  readonly truncated?: boolean;
}

/** Command 层翻译器：Tool call → ExecutionCommand。 */
export interface CommandTranslator {
  translate(toolCall: ToolCall, ctx: CommandSecurityContext): Promise<ExecutionCommand>;
}

/** Command 层授权器：权限/批准/白名单检查。 */
export interface CommandAuthorizer {
  authorize(command: ExecutionCommand, ctx: CommandSecurityContext): Promise<{ ok: true } | { ok: false; error: string }>;
}

/** Execute 层统一分发器。 */
export interface UnifiedExecutionDispatcher {
  execute(command: ExecutionCommand): Promise<ExecutionResult>;
}
