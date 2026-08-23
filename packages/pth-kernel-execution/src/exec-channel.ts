/**
 * kernel-exec-channel —— kernel 直连执行通道（2026-08-10 任务池纯化设计 D2）。
 *
 * 定位：直接面向 kernel 的 TS 操作（调试/运维/探查）——不占任务池（不进 task-store、
 * 不路由、不占 worker、无角色概念）。任务池纯化后，这是代码级执行的唯一入口。
 *
 * 双模式（用户裁决）：
 *   - stateless：每次调用独立 worker kernel（vm context 新建）——一次性调试命令
 *   - repl：sessionId 持久 worker kernel——多次执行共享 ts context（变量/声明保留）；
 *     idle TTL（默认 30min，PTH_EXEC_SESSION_TTL_MS）扫描回收
 *
 * 资源共享：python/bash 持久 kernel 由通道级 KernelManager 共享（与 worker 同构——
 * sandbox-kernel/kernel 模式随 env）。注意：python/bash 状态全局共享（manager 单例），
 * ts 状态按 session 隔离（vm context 每 kernel 独立）。
 *
 * 安全：继承 ts-interpreter 全部约束（import/require 拒绝、超时双保险）；
 * 路由层复用 /api/v1/kernel/* 既有 bearer 鉴权。
 */
import { randomUUID } from "node:crypto";
import type { Interpreter, InterpreterResult } from "@away_from/pth-kernel-interpreter";
import { getKernelExecFactory } from './execution/kernel-factories.js';
import { loadKernelConfig } from "@away_from/pth-kernel-interpreter";
import { createLlmFn, type LlmFn } from "@away_from/pth-kernel-interpreter";
import { createToolstore, type Toolstore } from "@away_from/pth-kernel-interpreter";
import type { DataWorldAccess } from "@away_from/pth-kernel-storage";
import type { ExecutionTargetDefinition, ExecutionTargetRegistry, NotebookLanguage } from "@away_from/pth-contracts";
import { pthConfig } from "@away_from/pth-config";
import type { CommandGateway, CommandSecurityContext } from "./execution/execution-command.js";

export interface ExecRequest {
  code: string;
  mode?: "stateless" | "repl";
  sessionId?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  durationMs: number;
  mode: "stateless" | "repl";
  sessionId?: string;
}

export interface NotebookCellRequest {
  /** python | bash | ts（python/bash 随 PTH_*_MODE 走 kernel/sandbox-kernel） */
  language: "python" | "bash" | "ts";
  code: string;
  /** 缺省新建 session 并返回；携带则续用该 session 的 kernel 状态 */
  sessionId?: string;
  timeoutMs?: number;
  /** ExecutionTarget id（cell magic 声明）；缺省按语言默认路由 */
  target?: string | null;
}

export interface NotebookCellResult {
  ok: boolean;
  value?: unknown;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs: number;
  sessionId: string;
  /** 实际命中的 ExecutionTarget id（观测用） */
  target?: string;
}

type ExecKernel = { ts: Interpreter; abort(): Promise<void> };
interface KernelManagerLike {
  execute(language: string, program: string, opts?: { timeoutMs?: number; exec?: string; space?: string }): Promise<InterpreterResult>;
  dispose(): void;
  abort?(): Promise<void>;
}

export interface ExecChannelDeps {
  dataWorld: DataWorldAccess;
  /** 测试注入缝：替换 kernel 工厂（默认真实装配——manager/llm/toolstore 懒初始化） */
  kernelFactory?: () => Promise<ExecKernel>;
  /** REPL 会话 idle TTL（默认 30min——PTH_EXEC_SESSION_TTL_MS 可配） */
  sessionTtlMs?: number;
  /** 回收扫描周期（默认 60s——测试可缩短） */
  sweepMs?: number;
  /** ExecutionTarget 注册表（装配层注入；缺省=legacy 写死路由） */
  targetRegistry?: ExecutionTargetRegistry;
  /** 一次性 execution-backend 执行适配（local/tool/jupyter；缺省=未接线，显式 command target 会拒绝） */
  targetBackendExecutor?: (target: ExecutionTargetDefinition, req: { language: NotebookLanguage; code: string; timeoutMs?: number }) => Promise<InterpreterResult>;
  /** TCE P3：Command 层注入（缺省保留 legacy 路径；注入后 notebook cell 先过 CommandGateway） */
  commandGateway?: CommandGateway;
}

export class KernelExecChannel {
  private manager: KernelManagerLike | null = null;
  private llm: LlmFn | null = null;
  private toolstore: Toolstore | null = null;
  private readonly sessions = new Map<string, { kernel: ExecKernel; lastUsed: number }>();
  /** P5b：notebook 会话——每 session 一个独立 KernelManager（python/bash 状态隔离） */
  private readonly notebookSessions = new Map<string, { manager: KernelManagerLike; lastUsed: number }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ttlMs: number;

  constructor(private deps: ExecChannelDeps) {
    this.ttlMs = deps.sessionTtlMs ?? pthConfig().num("PTH_EXEC_SESSION_TTL_MS");
    this.sweepTimer = setInterval(() => this.sweep(), deps.sweepMs ?? 60_000);
    this.sweepTimer.unref?.();
  }

  private createManager(): KernelManagerLike {
    const createKernelManager = getKernelExecFactory().createKernelManager as (opts: unknown) => KernelManagerLike;
    return createKernelManager({
      pythonMode: pthConfig().str("PTH_PYTHON_MODE") as "kernel" | "interpreter" | "sandbox-kernel",
      bashMode: pthConfig().str("PTH_BASH_MODE") as "kernel" | "interpreter" | "sandbox-kernel",
      sandboxKernel: {
        url: pthConfig().str("PTH_SANDBOX_KERNEL_URL"),
        secret: pthConfig().str("SANDBOX_SHARED_SECRET"),
        // P5b：notebook cell 走 sandbox-kernel 时自动签发 grant（与 batch 同款）。
        // 会话创建即绑定；跨任务动态绑定由 notebook session 级 manager 隔离。
        grantSecret: pthConfig().str("PTH_EXECUTION_GRANT_SECRET"),
        grantIdentity: {
          principalId: "engine:notebook-exec-channel",
          roleId: "developer",
          capabilities: ["memory.read"],
          tenantId: "system",
        },
      },
      kernelConfig: loadKernelConfig(process.env),
    });
  }

  /** 通道级共享资源懒初始化（manager/llm/toolstore——首次执行时建立） */
  private async ensureKernel(): Promise<ExecKernel> {
    if (this.deps.kernelFactory) return this.deps.kernelFactory();
    if (!this.manager) {
      this.manager = this.createManager();
    }
    if (!this.llm) {
      try {
        const { createKernelModelRouter } = await import("./execution/model-router.js");
        const router = await createKernelModelRouter();
        this.llm = createLlmFn({ modelRouter: router as any });   // KernelRouterLike 结构子集——batch-process 同款
      } catch {
        // llm 不可用不阻塞通道（代码调试多数不需要 LLM）——调用时才报错
        this.llm = { complete: async () => { throw new Error("exec-channel: llm unavailable（model router 初始化失败）"); } };
      }
    }
    if (!this.toolstore) {
      this.toolstore = createToolstore(pthConfig().str("PTH_TOOLSTORE_PATH") || "toolstore");
    }
    const createWorkerKernelWithManager = getKernelExecFactory().createWorkerKernelWithManager as (deps: unknown) => ExecKernel;
    return createWorkerKernelWithManager({
      llm: this.llm,
      dataWorld: this.deps.dataWorld,
      manager: this.manager,
      toolstore: this.toolstore,
    });
  }

  async execute(req: ExecRequest): Promise<ExecResult> {
    const mode = req.mode === "repl" ? "repl" : "stateless";
    if (mode === "stateless") {
      const kernel = await this.ensureKernel();
      const r: InterpreterResult = await kernel.ts.execute(req.code, { timeoutMs: req.timeoutMs });
      // stateless：不持有引用（ts context 随 GC；共享 manager 的 python/bash 不可 dispose）
      return { ok: r.ok, value: r.value, error: r.error?.message, durationMs: r.durationMs, mode };
    }
    // repl：sessionId 持久（缺省新建并返回 id——调用方后续携带）
    const sid = req.sessionId || randomUUID();
    let s = this.sessions.get(sid);
    if (!s) {
      s = { kernel: await this.ensureKernel(), lastUsed: Date.now() };
      this.sessions.set(sid, s);
    }
    s.lastUsed = Date.now();
    const r = await s.kernel.ts.execute(req.code, { timeoutMs: req.timeoutMs });
    return { ok: r.ok, value: r.value, error: r.error?.message, durationMs: r.durationMs, mode, sessionId: sid };
  }

  /** P5b：notebook cell 执行——每 session 独立 KernelManager，python/bash/ts 全路由。 */
  async executeNotebookCell(req: NotebookCellRequest): Promise<NotebookCellResult> {
    if (!["python", "bash", "ts"].includes(req.language)) {
      throw new Error(`exec-channel: unsupported notebook language ${req.language}`);
    }
    if (typeof req.code !== "string" || req.code.length === 0) {
      throw new Error("exec-channel: notebook code required");
    }

    // TCE P3：注入 CommandGateway 时，notebook cell 先过 Command 层（目标解析/权限/自批准）。
    let effectiveReq = req;
    if (this.deps.commandGateway) {
      const ctx: CommandSecurityContext = { principalId: "engine:notebook-exec-channel", tenantId: "system", roleId: "developer" };
      const decision = await this.deps.commandGateway.decide({
        surface: "notebook",
        cell: { language: req.language, code: req.code, target: req.target ?? null, sessionId: req.sessionId, timeoutMs: req.timeoutMs },
        ctx,
      });
      if (decision.kind === "deny") throw new Error(decision.reason);
      if (decision.kind === "await-approval") throw new Error("exec-channel: notebook 不应 await-approval（人类自批准）");
      const command = decision.command;
      if (command.kind === "language" && command.target) {
        effectiveReq = { ...req, target: command.target };
      }
    }

    // ExecutionTarget 路由（装配层注入后启用；未注入=legacy 写死路径）。
    let targetId: string | undefined;
    if (this.deps.targetRegistry) {
      const { resolveNotebookTarget } = await import("./execution/notebook-target-router.js");
      const { target } = resolveNotebookTarget(this.deps.targetRegistry, effectiveReq.language, effectiveReq.target ?? null);
      targetId = target.id;

      // Phase 2 结构断言（defense-in-depth）：tool-container 只收 external argv，不接受 language 代码。
      if (target.profile === "dev-container") {
        throw new Error(`exec-channel: ExecutionTarget ${target.id} 是 tool-container——不接受 language 代码，请使用 external 命令（argv 白名单）`);
      }

      // 一次性 command target（local/tool/jupyter）：经 targetBackendExecutor 执行。
      if (target.binding.type === "execution-backend") {
        if (!this.deps.targetBackendExecutor) {
          throw new Error(`exec-channel: ExecutionTarget ${target.id} 需要 targetBackendExecutor（装配层未注入）`);
        }
        const r = await this.deps.targetBackendExecutor(target, {
          language: effectiveReq.language,
          code: effectiveReq.code,
          timeoutMs: effectiveReq.timeoutMs,
        });
        return {
          ok: r.ok,
          ...(r.value !== undefined ? { value: r.value } : {}),
          ...(r.stdout !== undefined ? { stdout: r.stdout } : {}),
          ...(r.stderr !== undefined ? { stderr: r.stderr } : {}),
          ...(r.error !== undefined ? { error: r.error.message } : {}),
          durationMs: r.durationMs,
          sessionId: effectiveReq.sessionId ?? "",
          target: target.id,
        };
      }

      // 目前仅支持 sandbox persistent session；其他 execution-session target 明确拒绝。
      if (target.binding.type === "execution-session" && target.binding.backendId !== "sandbox") {
        throw new Error(`exec-channel: execution-session target ${target.id} 尚未支持（当前仅 sandbox）`);
      }
      // engine-internal 与 sandbox 都继续走 KernelManager（ts 在 engine 内，python/bash 走 sandbox-kernel）。
    }

    const sid = effectiveReq.sessionId || randomUUID();
    let session = this.notebookSessions.get(sid);
    if (!session) {
      session = { manager: this.createManager(), lastUsed: Date.now() };
      this.notebookSessions.set(sid, session);
    }
    session.lastUsed = Date.now();
    const r = await session.manager.execute(effectiveReq.language, effectiveReq.code, { timeoutMs: effectiveReq.timeoutMs });
    return {
      ok: r.ok,
      ...(r.value !== undefined ? { value: r.value } : {}),
      ...(r.stdout !== undefined ? { stdout: r.stdout } : {}),
      ...(r.stderr !== undefined ? { stderr: r.stderr } : {}),
      ...(r.error !== undefined ? { error: r.error.message } : {}),
      durationMs: r.durationMs,
      sessionId: sid,
      ...(targetId ? { target: targetId } : {}),
    };
  }

  /** P5d：notebook session cancel——abort in-flight 核后 dispose（不可恢复，caller 重建）。 */
  async cancelNotebook(sessionId: string): Promise<boolean> {
    const session = this.notebookSessions.get(sessionId);
    if (!session) return false;
    await session.manager.abort?.().catch(() => undefined);
    session.manager.dispose();
    this.notebookSessions.delete(sessionId);
    return true;
  }

  /** idle 会话回收（TTL——防 session 泄漏） */
  private sweep(): void {
    const now = Date.now();
    for (const [sid, s] of this.sessions) {
      if (now - s.lastUsed > this.ttlMs) this.sessions.delete(sid);  // ts context GC；共享 manager 不动
    }
    for (const [sid, s] of this.notebookSessions) {
      if (now - s.lastUsed > this.ttlMs) {
        s.manager.dispose();
        this.notebookSessions.delete(sid);
      }
    }
  }

  /** 活跃会话数（观测/测试用） */
  get sessionCount(): number {
    return this.sessions.size;
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sessions.clear();
    for (const session of this.notebookSessions.values()) session.manager.dispose();
    this.notebookSessions.clear();
    this.manager?.dispose();   // 归还 sandbox kernel 租约（防池泄漏）
    this.manager = null;
  }
}
