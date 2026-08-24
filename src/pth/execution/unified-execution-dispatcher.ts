/**
 * execution/unified-execution-dispatcher.ts —— Execute 层统一分发器。
 *
 * 只消费 ExecutionCommand，不做权限/批准决策（Command 层负责）。
 * 职责：
 *  - language 命令 → 按 ExecutionTargetRegistry 路由（engine-internal / execution-session / execution-backend）；
 *  - external 命令 → 按显式 target 路由到 execution-backend（argv 白名单）；
 *  - internal 命令 → 透传进程内能力执行器。
 *
 * 安全约定：
 *  - `dev-container`（tool-container）只接受 `kind: "external"`，拒绝 `language` 代码，
 *    防止 `bash -lc` 绕过 manifest argv 白名单。
 *  - 未注入 targetRegistry 时退化为显式 target 直连（测试/legacy 兼容）。
 */

import type {
  ExecutionTargetDefinition,
  ExecutionTargetRegistry,
  NotebookLanguage,
} from "@away_from/pth-contracts";
import type {
  ExecutionCommand,
  ExecutionResult,
  UnifiedExecutionDispatcher,
} from "@away_from/pth-kernel-execution";
import type { InterpreterResult } from "@away_from/pth-kernel-interpreter";
import type { ExecutionBackendRegistry } from "./backend-registry.js";

export interface EngineTsExecutorRequest {
  code: string;
  mode?: "single" | "program";
  caps?: Record<string, unknown>;
  taskWorkspace?: string;
  timeoutMs?: number;
  space?: string;
}

export interface SessionExecutorRequest {
  language: NotebookLanguage;
  code: string;
  mode?: "single" | "program";
  sessionId?: string;
  timeoutMs?: number;
  space?: string;
}

export interface CommandExecutorRequest {
  argv: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface UnifiedExecutionDispatcherDeps {
  targetRegistry?: ExecutionTargetRegistry;
  backendRegistry?: ExecutionBackendRegistry;
  /** engine-internal ts 执行器（缺省 = 不支持）。 */
  engineTsExecutor?: (req: EngineTsExecutorRequest) => Promise<InterpreterResult>;
  /** persistent execution-session 执行器（缺省 = 不支持）。 */
  sessionExecutor?: (req: SessionExecutorRequest) => Promise<InterpreterResult>;
  /** execution-backend 命令执行器（缺省 = 不支持）。 */
  commandExecutor?: (target: ExecutionTargetDefinition, req: CommandExecutorRequest) => Promise<InterpreterResult>;
  /** internal 能力执行器（缺省 = 不支持）。 */
  internalExecutor?: (capability: string, args: Record<string, unknown>) => Promise<ExecutionResult>;
  /** agent 子任务执行器（Tool-Reg v2 agent adapter；缺省 = 不支持）。 */
  agentExecutor?: (command: Extract<ExecutionCommand, { kind: "agent" }>) => Promise<ExecutionResult>;
  /** 生成 command id（缺省随机）。 */
  createId?: () => string;
}

function interpreterToExecutionResult(r: InterpreterResult, target: string, sessionId?: string): ExecutionResult {
  return {
    ok: r.ok,
    ...(r.value !== undefined ? { value: r.value } : {}),
    ...(r.stdout !== undefined ? { stdout: r.stdout } : {}),
    ...(r.stderr !== undefined ? { stderr: r.stderr } : {}),
    ...(r.error !== undefined ? { error: { message: r.error.message, ...(r.error.code !== undefined ? { code: r.error.code } : {}) } } : {}),
    durationMs: r.durationMs,
    target,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(r.truncated !== undefined ? { truncated: true } : {}),
  };
}

export class UnifiedExecutionDispatcherImpl implements UnifiedExecutionDispatcher {
  private readonly targetRegistry?: ExecutionTargetRegistry;
  private readonly backendRegistry?: ExecutionBackendRegistry;
  private readonly engineTsExecutor?: UnifiedExecutionDispatcherDeps["engineTsExecutor"];
  private readonly sessionExecutor?: UnifiedExecutionDispatcherDeps["sessionExecutor"];
  private readonly commandExecutor?: UnifiedExecutionDispatcherDeps["commandExecutor"];
  private readonly internalExecutor?: UnifiedExecutionDispatcherDeps["internalExecutor"];
  private readonly agentExecutor?: UnifiedExecutionDispatcherDeps["agentExecutor"];
  private readonly createId: () => string;

  constructor(deps: UnifiedExecutionDispatcherDeps) {
    this.targetRegistry = deps.targetRegistry;
    this.backendRegistry = deps.backendRegistry;
    this.engineTsExecutor = deps.engineTsExecutor;
    this.sessionExecutor = deps.sessionExecutor;
    this.commandExecutor = deps.commandExecutor;
    this.internalExecutor = deps.internalExecutor;
    this.agentExecutor = deps.agentExecutor;
    this.createId = deps.createId ?? (() => `exec-${Math.random().toString(36).slice(2, 10)}`);
  }

  async execute(command: ExecutionCommand): Promise<ExecutionResult> {
    const id = command.id || this.createId();
    const started = Date.now();
    try {
      if (command.kind === "language") return await this.executeLanguage(command, id, started);
      if (command.kind === "external") return await this.executeExternal(command, id, started);
      if (command.kind === "agent") return await this.executeAgent(command, id, started);
      return await this.executeInternal(command, id, started);
    } catch (error) {
      return {
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
        durationMs: Date.now() - started,
      };
    }
  }

  private async executeLanguage(command: Extract<ExecutionCommand, { kind: "language" }>, id: string, started: number): Promise<ExecutionResult> {
    // Execute 层不做默认路由：target 必须由 Command 层解析为具体 id。
    if (!command.target) {
      throw new Error("language 命令必须由 Command 层解析出具体 target");
    }
    const target = this.resolveLanguageTarget(command.language, command.target);
    if (target.routing.requiresApproval && !command.security.approval) {
      throw new Error(`ExecutionTarget ${target.id} 需要批准（requiresApproval）——Execute 层拒绝未盖章命令`);
    }
    if (target.binding.type === "engine-internal") {
      if (command.language !== "ts") {
        throw new Error(`execution target ${target.id} 仅支持 ts（请求 ${command.language}）`);
      }
      if (!this.engineTsExecutor) {
        throw new Error(`execution target ${target.id} 需要 engineTsExecutor（未注入）`);
      }
      const r = await this.engineTsExecutor({
        code: command.code,
        ...(command.mode ? { mode: command.mode } : {}),
        ...(command.caps ? { caps: command.caps } : {}),
        ...(command.taskWorkspace ? { taskWorkspace: command.taskWorkspace } : {}),
        ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
        ...(command.space ? { space: command.space } : {}),
      });
      return interpreterToExecutionResult(r, target.id, command.sessionId ?? undefined);
    }
    if (target.binding.type === "execution-session") {
      if (!this.sessionExecutor) {
        throw new Error(`execution target ${target.id} 需要 sessionExecutor（未注入）`);
      }
      const r = await this.sessionExecutor({
        language: command.language,
        code: command.code,
        ...(command.mode ? { mode: command.mode } : {}),
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
        ...(command.space ? { space: command.space } : {}),
      });
      return interpreterToExecutionResult(r, target.id, command.sessionId ?? undefined);
    }
    // execution-backend：language 命令只允许非 dev-container（tool-container 必须走 external）。
    if (target.profile === "dev-container") {
      throw new Error(`execution target ${target.id} 是 tool-container——不接受 language 代码，请使用 external 命令（argv 白名单）`);
    }
    if (!this.commandExecutor) {
      throw new Error(`execution target ${target.id} 需要 commandExecutor（未注入）`);
    }
    const argv = this.languageToArgv(command.language, command.code);
    const r = await this.commandExecutor(target, {
      argv,
      ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
    });
    return interpreterToExecutionResult(r, target.id, command.sessionId ?? undefined);
  }

  private async executeExternal(command: Extract<ExecutionCommand, { kind: "external" }>, id: string, started: number): Promise<ExecutionResult> {
    if (!command.target) {
      throw new Error("external 命令必须显式指定 target");
    }
    const target = this.targetRegistry?.get(command.target)
      ?? this.backendTargetFromBackendRegistry(command.target);
    if (!target) {
      throw new Error(`ExecutionTarget 不存在: ${command.target}`);
    }
    if (target.routing.requiresApproval && !command.security.approval) {
      throw new Error(`ExecutionTarget ${target.id} 需要批准（requiresApproval）——Execute 层拒绝未盖章命令`);
    }
    if (target.binding.type !== "execution-backend") {
      throw new Error(`execution target ${target.id} 不是 execution-backend，不能接收 external 命令`);
    }
    if (!this.commandExecutor) {
      throw new Error(`execution target ${target.id} 需要 commandExecutor（未注入）`);
    }
    const r = await this.commandExecutor(target, {
      argv: command.argv,
      ...(command.cwd ? { cwd: command.cwd } : {}),
      ...(command.env ? { env: command.env } : {}),
      ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
      ...(command.maxOutputBytes ? { maxOutputBytes: command.maxOutputBytes } : {}),
    });
    return interpreterToExecutionResult(r, target.id);
  }

  private async executeInternal(command: Extract<ExecutionCommand, { kind: "internal" }>, id: string, started: number): Promise<ExecutionResult> {
    if (!this.internalExecutor) {
      throw new Error(`internal 命令需要 internalExecutor（未注入）`);
    }
    const r = await this.internalExecutor(command.capability, command.args);
    return { ...r, durationMs: r.durationMs || (Date.now() - started) };
  }

  private async executeAgent(command: Extract<ExecutionCommand, { kind: "agent" }>, id: string, started: number): Promise<ExecutionResult> {
    if (!this.agentExecutor) {
      throw new Error(`agent 命令需要 agentExecutor（未注入）`);
    }
    const r = await this.agentExecutor(command);
    return { ...r, durationMs: r.durationMs || (Date.now() - started) };
  }

  private resolveLanguageTarget(language: NotebookLanguage, target: string): ExecutionTargetDefinition {
    const t = this.targetRegistry?.get(target) ?? this.backendTargetFromBackendRegistry(target);
    if (!t) throw new Error(`ExecutionTarget 不存在: ${target}`);
    if (!t.languages.includes(language)) {
      throw new Error(`ExecutionTarget ${target} 不支持 language ${language}`);
    }
    // userSelectable 是 Command 层策略，Execute 层不重复判定（纯结构路由）。
    return t;
  }

  private backendTargetFromBackendRegistry(backendId: string): ExecutionTargetDefinition | undefined {
    if (!this.backendRegistry) return undefined;
    const backend = this.backendRegistry.get(backendId);
    if (!backend) return undefined;
    return {
      id: backend.id,
      kind: "command",
      profile: backend.descriptor.profile,
      languages: ["bash"],
      modes: { sync: true, stream: false, interactive: false, persistent: false },
      session: { type: "one-shot" },
      capabilities: { richMedia: false, streaming: false, cancel: false, pathMapping: backend.descriptor.pathMapping !== undefined },
      routing: { defaultFor: [], userSelectable: true, requiresApproval: true },
      binding: { type: "execution-backend", backendId: backend.id, mode: "sync" },
    };
  }

  private languageToArgv(language: NotebookLanguage, code: string): readonly string[] {
    if (language === "bash") return ["bash", "-lc", code];
    if (language === "python") return ["python3", "-c", code];
    throw new Error(`language ${language} 不支持 execution-backend 路由`);
  }
}
