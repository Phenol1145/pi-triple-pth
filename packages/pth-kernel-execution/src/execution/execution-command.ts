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
import type { CommandFeedback } from "./command-feedback.js";

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

/**
 * Adapter 产出的待授权请求（pre-authorization）。
 * Command 层必须把 ExecutionRequest 规范化为 ExecutionCommand 并过 CommandGateway 授权；
 * adapter 不得直接执行，也不得返回最终 execute/await-approval 决策。
 */
export type ExecutionRequest =
  | {
      readonly kind: "language";
      readonly tool: string;
      readonly language: NotebookLanguage;
      readonly code: string;
      readonly target?: string | null;
      readonly timeoutMs?: number;
      readonly mode?: "single" | "program";
      readonly sessionId?: string | null;
      readonly space?: string;
      readonly taskWorkspace?: string;
      readonly caps?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "external";
      readonly tool: string;
      readonly argv: readonly string[];
      readonly target?: string | null;
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
    }
  | {
      readonly kind: "internal";
      readonly tool: string;
      readonly capability: string;
      readonly args: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "agent";
      readonly tool: string;
      readonly role: string;
      readonly input?: string;
      readonly output?: string;
      readonly target?: string | null;
      readonly timeoutMs?: number;
    };

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
  | { readonly kind: "deny"; readonly reason: string; readonly feedback?: CommandFeedback }
  | { readonly kind: "await-approval"; readonly requestId: string; readonly command: ExecutionCommand };

/** Command 层入口端口：翻译 + 目标决策 + 权限审查。 */
export interface CommandGateway {
  decide(input: CommandInput): Promise<CommandDecision>;
  /**
   * Wave 2：adapter 产出 ExecutionRequest 后的授权入口（可选）。
   * 若未实现，调用方应回退到 ToolCall 入口或 fail-closed。
   */
  decideRequest?(request: ExecutionRequest, ctx: CommandSecurityContext): Promise<CommandDecision>;
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
      readonly kind: "agent";
      readonly role: string;
      readonly input?: string;
      readonly output?: string;
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

/** 默认 command id 生成（审计/追踪）。 */
export function createExecutionCommandId(): string {
  return `exec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Adapter 产出的 ExecutionRequest → 规范化 ExecutionCommand。
 * 注意：这只是结构规范化，授权仍由 CommandGateway 负责。
 */
export function normalizeExecutionRequestToCommand(
  request: ExecutionRequest,
  security: CommandSecurityContext,
  id: string = createExecutionCommandId(),
): ExecutionCommand {
  const base: ExecutionCommandBase = {
    id,
    tool: request.tool,
    scope: "task",
    security,
    ...(request.kind !== "internal" ? { target: request.target ?? null, timeoutMs: request.timeoutMs } : {}),
  };
  if (request.kind === "language") {
    return {
      ...base,
      kind: "language",
      language: request.language,
      code: request.code,
      ...(request.mode ? { mode: request.mode } : {}),
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.space ? { space: request.space } : {}),
      ...(request.taskWorkspace ? { taskWorkspace: request.taskWorkspace } : {}),
      ...(request.caps ? { caps: request.caps } : {}),
    };
  }
  if (request.kind === "external") {
    return {
      ...base,
      kind: "external",
      argv: request.argv,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.env ? { env: request.env } : {}),
      ...(request.maxOutputBytes ? { maxOutputBytes: request.maxOutputBytes } : {}),
    };
  }
  if (request.kind === "agent") {
    return {
      ...base,
      kind: "agent",
      role: request.role,
      ...(request.input ? { input: request.input } : {}),
      ...(request.output ? { output: request.output } : {}),
    };
  }
  return {
    ...base,
    kind: "internal",
    capability: request.capability,
    args: request.args,
  };
}
