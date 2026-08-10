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
import type { InterpreterResult } from "./interpreter/types.js";
import { createKernelManager, createWorkerKernelWithManager, type KernelManager } from "./interpreter/kernel-manager.js";
import { loadKernelConfig } from "./interpreter/kernel-config.js";
import { createLlmFn, type LlmFn } from "./interpreter/llm-fn.js";
import { createToolstore, type Toolstore } from "./interpreter/toolstore.js";
import type { DataWorldAccess } from "./storage/index.js";

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

type ExecKernel = ReturnType<typeof createWorkerKernelWithManager>;

export interface ExecChannelDeps {
  dataWorld: DataWorldAccess;
  /** 测试注入缝：替换 kernel 工厂（默认真实装配——manager/llm/toolstore 懒初始化） */
  kernelFactory?: () => Promise<ExecKernel>;
  /** REPL 会话 idle TTL（默认 30min——PTH_EXEC_SESSION_TTL_MS 可配） */
  sessionTtlMs?: number;
  /** 回收扫描周期（默认 60s——测试可缩短） */
  sweepMs?: number;
}

export class KernelExecChannel {
  private manager: KernelManager | null = null;
  private llm: LlmFn | null = null;
  private toolstore: Toolstore | null = null;
  private readonly sessions = new Map<string, { kernel: ExecKernel; lastUsed: number }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ttlMs: number;

  constructor(private deps: ExecChannelDeps) {
    this.ttlMs = deps.sessionTtlMs ?? Number(process.env.PTH_EXEC_SESSION_TTL_MS ?? 30 * 60_000);
    this.sweepTimer = setInterval(() => this.sweep(), deps.sweepMs ?? 60_000);
    this.sweepTimer.unref?.();
  }

  /** 通道级共享资源懒初始化（manager/llm/toolstore——首次执行时建立） */
  private async ensureKernel(): Promise<ExecKernel> {
    if (this.deps.kernelFactory) return this.deps.kernelFactory();
    if (!this.manager) {
      this.manager = createKernelManager({
        pythonMode: (process.env.PTH_PYTHON_MODE as "kernel" | "interpreter" | "sandbox-kernel" | undefined) ?? "kernel",
        bashMode: (process.env.PTH_BASH_MODE as "kernel" | "interpreter" | "sandbox-kernel" | undefined) ?? "kernel",
        sandboxKernel: {
          url: process.env.PTH_SANDBOX_KERNEL_URL ?? "http://sandbox:8080",
          secret: process.env.SANDBOX_SHARED_SECRET ?? "",
        },
        kernelConfig: loadKernelConfig(process.env),
      });
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
      this.toolstore = createToolstore(process.env.PTH_TOOLSTORE_PATH ?? "toolstore");
    }
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

  /** idle 会话回收（TTL——防 session 泄漏） */
  private sweep(): void {
    const now = Date.now();
    for (const [sid, s] of this.sessions) {
      if (now - s.lastUsed > this.ttlMs) this.sessions.delete(sid);  // ts context GC；共享 manager 不动
    }
  }

  /** 活跃会话数（观测/测试用） */
  get sessionCount(): number {
    return this.sessions.size;
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sessions.clear();
    this.manager?.dispose();   // 归还 sandbox kernel 租约（防池泄漏）
    this.manager = null;
  }
}
