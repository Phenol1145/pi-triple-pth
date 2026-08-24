/**
 * execution/command-gateway.ts —— TCE Command 层实现（Phase 3）。
 *
 * 职责：translate（tool call / notebook cell → ExecutionCommand）→ resolveTarget →
 * authorize（EXEC_TOOL_CAP + 批准按行为者）。输出三态 CommandDecision。
 * 不 import backend/kernel 实现；target 解析为具体 id 后交给 Execute 层。
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  CommandDecision,
  CommandGateway,
  CommandInput,
  CommandSecurityContext,
  ExecutionCommand,
  ExecutionRequest,
  HumanApprovalGateway,
  ToolCall,
} from "@away_from/pth-kernel-execution";
import { execToolCapFor, hasExecToolCapability, normalizeExecutionRequestToCommand } from "@away_from/pth-kernel-execution";
import type { ExecutionTargetRegistry, NotebookLanguage } from "@away_from/pth-contracts";
import { hasInternalCapability, internalCapabilityPolicy } from "./capability-policy.js";

interface LanguageToolSpec {
  language: NotebookLanguage;
  mode?: "single" | "program";
  codeKey: string;
}

const LANGUAGE_TOOL_SPECS: Record<string, LanguageToolSpec> = {
  "ts.run": { language: "ts", mode: "program", codeKey: "code" },
  "ts.eval": { language: "ts", mode: "single", codeKey: "code" },
  "python.run": { language: "python", mode: "program", codeKey: "code" },
  "python.eval": { language: "python", mode: "single", codeKey: "code" },
  "bash.run": { language: "bash", mode: "program", codeKey: "command" },
  "bash.eval": { language: "bash", mode: "single", codeKey: "command" },
};

export interface CommandGatewayDeps {
  targetRegistry?: ExecutionTargetRegistry;
  humanApprovalGateway?: HumanApprovalGateway;
  /** 角色能力查询（缺省 undefined = 未声明全量兼容） */
  roleCapabilities?: (roleId: string) => readonly string[] | undefined;
  /** TCE P5：per-tool 翻译器（manifest tool → external command；返回 null 表示非 per-tool） */
  toolTranslator?: (
    toolCall: ToolCall,
    ctx: CommandSecurityContext,
  ) => Promise<Extract<ExecutionCommand, { kind: "external" }> | null>;
  createId?: () => string;
}

function fingerprintOf(command: ExecutionCommand): string {
  const payload = {
    tool: command.tool,
    kind: command.kind,
    target: command.target ?? null,
    ...(command.kind === "language" ? { language: command.language, code: command.code } : {}),
    ...(command.kind === "external" ? { argv: command.argv } : {}),
    ...(command.kind === "internal" ? { capability: command.capability, args: command.args } : {}),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export class CommandGatewayImpl implements CommandGateway {
  private readonly targetRegistry?: ExecutionTargetRegistry;
  private readonly humanApprovalGateway?: HumanApprovalGateway;
  private readonly roleCapabilities?: (roleId: string) => readonly string[] | undefined;
  private readonly toolTranslator?: CommandGatewayDeps["toolTranslator"];
  private readonly createId: () => string;

  constructor(deps: CommandGatewayDeps = {}) {
    this.targetRegistry = deps.targetRegistry;
    this.humanApprovalGateway = deps.humanApprovalGateway;
    this.roleCapabilities = deps.roleCapabilities;
    this.toolTranslator = deps.toolTranslator;
    this.createId = deps.createId ?? (() => `cmd-${randomUUID()}`);
  }

  async decide(input: CommandInput): Promise<CommandDecision> {
    if (input.surface === "notebook") return this.decideNotebook(input);
    return this.decideAgentTool(input);
  }

  async decideRequest(request: ExecutionRequest, ctx: CommandSecurityContext): Promise<CommandDecision> {
    const command = normalizeExecutionRequestToCommand(request, ctx, this.createId());
    return this.authorize(command, ctx, "agent-tool");
  }

  private async decideAgentTool(input: Extract<CommandInput, { surface: "agent-tool" }>): Promise<CommandDecision> {
    const { toolCall, ctx } = input;
    const command = await this.translateToolCall(toolCall, ctx);
    return this.authorize(command, ctx, "agent-tool");
  }

  private async decideNotebook(input: Extract<CommandInput, { surface: "notebook" }>): Promise<CommandDecision> {
    const { cell, ctx } = input;
    const command = this.buildLanguageCommand({
      tool: `notebook:${cell.language}`,
      language: cell.language,
      code: cell.code,
      mode: "single",
      target: cell.target ?? null,
      sessionId: cell.sessionId,
      timeoutMs: cell.timeoutMs,
      ctx,
    });
    const resolved = this.resolveLanguageTarget(command);
    const withTarget: ExecutionCommand = { ...resolved, target: resolved.target };
    // 人类 principal：选择即批准（自批准，进审计）。
    const approvedCtx: CommandSecurityContext = {
      ...ctx,
      approval: { ref: `principal:${ctx.principalId}`, decision: "approved" },
    };
    return { kind: "execute", command: { ...withTarget, security: approvedCtx } };
  }

  private async translateToolCall(toolCall: ToolCall, ctx: CommandSecurityContext): Promise<ExecutionCommand> {
    const tool = toolCall.tool.replace(/_/g, ".");
    const spec = LANGUAGE_TOOL_SPECS[tool];
    if (spec) {
      const code = toolCall.args[spec.codeKey];
      if (typeof code !== "string" || code.trim() === "") {
        throw new Error(`command-gateway: ${tool} 缺少 ${spec.codeKey}（非空字符串）`);
      }
      return this.buildLanguageCommand({
        tool,
        language: spec.language,
        code,
        mode: spec.mode,
        target: null,
        ctx,
      });
    }
    // TCE P5：per-tool 翻译器（manifest tool → external command）
    if (this.toolTranslator) {
      const external = await this.toolTranslator(toolCall, ctx);
      if (external) return external;
    }
    // 非语言工具：v1 降级为 internal（后续 Tool 层/内部命令收编扩展）。
    return {
      id: this.createId(),
      tool,
      scope: ctx.taskId ? "task" : "notebook",
      kind: "internal",
      capability: tool,
      args: toolCall.args,
      security: ctx,
    };
  }

  private buildLanguageCommand(input: {
    tool: string;
    language: NotebookLanguage;
    code: string;
    mode?: "single" | "program";
    target?: string | null;
    sessionId?: string;
    timeoutMs?: number;
    ctx: CommandSecurityContext;
  }): Extract<ExecutionCommand, { kind: "language" }> {
    return {
      id: this.createId(),
      tool: input.tool,
      scope: input.ctx.taskId ? "task" : "notebook",
      kind: "language",
      language: input.language,
      code: input.code,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      security: input.ctx,
    };
  }

  private resolveLanguageTarget(command: Extract<ExecutionCommand, { kind: "language" }>): Extract<ExecutionCommand, { kind: "language" }> {
    if (!this.targetRegistry) {
      // 无 registry：测试/legacy——target 留空由 Execute 层拒绝（Command 层本应解析）。
      return command;
    }
    const target = command.target
      ? this.targetRegistry.get(command.target)
      : this.targetRegistry.resolve(command.language, null);
    if (!target) throw new Error(`command-gateway: ExecutionTarget 不存在 ${command.target}`);
    if (!target.languages.includes(command.language)) {
      throw new Error(`command-gateway: ExecutionTarget ${target.id} 不支持 language ${command.language}`);
    }
    return { ...command, target: target.id };
  }

  private async authorize(command: ExecutionCommand, ctx: CommandSecurityContext, surface: "agent-tool" | "notebook"): Promise<CommandDecision> {
    // 语言命令能力门控（EXEC_TOOL_CAP 共用纯函数）
    if (command.kind === "language") {
      const fam = command.language === "python" || command.language === "bash" ? command.language : "ts";
      const caps = this.roleCapabilities?.(ctx.roleId);
      if (!hasExecToolCapability(fam, caps)) {
        const need = execToolCapFor(fam) ?? [];
        return { kind: "deny", reason: `command-gateway: 角色 ${ctx.roleId} capabilities 未含 ${need.join("/")}（拒绝 ${command.tool}）` };
      }
    }
    if (command.kind === "internal") {
      const caps = this.roleCapabilities?.(ctx.roleId);
      if (!hasInternalCapability(command.capability, caps)) {
        return { kind: "deny", reason: `command-gateway: 角色 ${ctx.roleId} capabilities 未含 ${command.capability} 所需能力（拒绝 ${command.tool}）` };
      }
    }

    // target 解析（仅 language/external 需要；internal 无 target）
    let resolved: ExecutionCommand = command;
    if (command.kind === "language" || command.kind === "external") {
      if (command.kind === "language") {
        resolved = this.resolveLanguageTarget(command);
      } else if (!command.target) {
        return { kind: "deny", reason: "command-gateway: external 命令必须显式指定 target" };
      }
    }

    const targetDef = resolved.kind !== "internal" && resolved.target
      ? this.targetRegistry?.get(resolved.target)
      : undefined;
    const internalPolicy = resolved.kind === "internal" ? internalCapabilityPolicy(resolved.capability) : undefined;

    // 批准（按行为者）：人类 notebook 自批准在 decideNotebook 已盖章；agent-tool 需人工批准。
    const needsApproval = (targetDef?.routing.requiresApproval || internalPolicy?.approval === "human") && !resolved.security.approval;
    if (needsApproval) {
      if (surface === "notebook") {
        resolved = {
          ...resolved,
          security: { ...resolved.security, approval: { ref: `principal:${ctx.principalId}`, decision: "approved" } },
        };
        return { kind: "execute", command: resolved };
      }
      if (!this.humanApprovalGateway) {
        return { kind: "deny", reason: `command-gateway: ${targetDef?.id ?? resolved.tool} 需要批准但未装配 HumanApprovalGateway` };
      }
      const fingerprint = fingerprintOf(resolved);
      const { requestId } = await this.humanApprovalGateway.requestApproval({ command: resolved, ctx: resolved.security, fingerprint });
      return { kind: "await-approval", requestId, command: resolved };
    }

    return { kind: "execute", command: resolved };
  }
}
