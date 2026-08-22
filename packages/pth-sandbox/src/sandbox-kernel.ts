/**
 * sandbox-kernel.ts —— PTH 侧 SandboxKernel 适配器（kernel sandbox SPEC §3.3 / P4）
 *
 * 实现统一 Interpreter 接口（execute/reset/snapshot/dispose），经 execution/v1.1
 * persistent /sessions 把调用转发到 sandbox 侧 kernel 宿主（HTTP）。
 *
 * P4 迁移（2026-08-22 裁决）：
 *  - acquire = POST /sessions（私有头 x-sandbox-kernel-lang + x-sandbox-grant 盖章任务绑定）；
 *  - execute/reset/snapshot/release 全部走 /sessions/:id/*，不再携带/暴露 kernel lease id；
 *  - execute 携带 x-sandbox-kernel-exec / x-sandbox-kernel-space 私有头（wire body 不变）；
 *  - snapshot 返回 wire 的 state 字段（InterpreterSnapshot 状态导出，非可恢复 checkpoint）；
 *  - abort：本地 session 立即作废且**不 release**（无 in-flight 归还 = 池条目绝不乐观复用，
 *    由 sandbox pool TTL 兜底回收）；正常 dispose 才 release 归还池。
 */

import { EXECUTION_WIRE } from "@away_from/shared/execution";
import { loadSandboxConfig } from "./config.js";
import { sandboxGrantToHeader } from "./authorization/grant-verifier.js";
import type { SandboxExecutionGrant, SandboxGrantContext } from "./authorization/grant-verifier.js";
import type { ExecuteOptions, Interpreter, InterpreterResult, InterpreterSnapshot } from "./kernel/interpreter/types.js";

export class SandboxKernelHttpError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "SandboxKernelHttpError";
    this.code = code;
    this.status = status;
  }
}

export interface SandboxKernelOptions {
  /** sandbox 宿主 base URL（如 http://sandbox:8080） */
  url: string;
  /** 共享密钥（/sessions 的 Bearer 认证） */
  secret?: string;
  /** 执行 grant（静态或按 acquire 时机 + language 提供）——会话创建唯一授权凭据 */
  grant?: SandboxExecutionGrant | ((language: "python" | "bash", context?: SandboxGrantContext) => Promise<SandboxExecutionGrant> | SandboxExecutionGrant);
  /** python | bash */
  language: "python" | "bash";
  /** 构造时创建会话（默认 true）；false 供测试/懒创建 */
  acquireOnInit?: boolean;
  /** 超时保护（fetch 层，默认 10s——宿主内部有执行超时） */
  requestTimeoutMs?: number;
  /** 会话创建排队等待上限（池满时 FIFO 排队——默认 60s） */
  acquireTimeoutMs?: number;
}

export class SandboxKernel implements Interpreter {
  readonly language: string;
  /** 远程状态经 execute/snapshot 访问——本地同步读返回空 */
  readonly state: Record<string, unknown> = {};
  private readonly url: string;
  private readonly secret: string | undefined;
  private readonly grant: SandboxKernelOptions["grant"];
  /** 任务级 grant 上下文（setGrantContext 更新——换任务时释放旧会话重新创建） */
  private grantContext: SandboxGrantContext | null = null;
  private sessionId: string | null = null;
  private cachedGrant: SandboxExecutionGrant | null = null;
  private sessionGrantTaskId: string | null = null;
  private readonly requestTimeoutMs: number;
  private readonly acquireTimeoutMs: number;
  private disposed = false;
  private releasePromise: Promise<void> | null = null;
  private acquirePromise: Promise<void> | null = null;
  /** in-flight HTTP 请求控制器（abort 终止 execute/acquire） */
  private inflightCtrl: AbortController | null = null;

  /** 任务级动态绑定：更新 grant 上下文（下个 execute 前换会话） */
  setGrantContext(ctx: SandboxGrantContext): void {
    this.grantContext = ctx;
  }

  /** 会话创建完成的 promise（测试/依赖方等待用——懒 acquire 异步） */
  get ready(): Promise<void> {
    return this.acquire();
  }

  constructor(opts: SandboxKernelOptions) {
    this.language = opts.language;
    this.url = opts.url.replace(/\/+$/, "");
    this.secret = opts.secret;
    this.grant = opts.grant;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 60_000;
    if (opts.acquireOnInit !== false) {
      // 懒获取：失败不炸构造（宿主暂不可达/池满排队）——后续 execute 时重试
      void this.acquire().catch(() => {});
    }
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs?: number,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const ctrl = new AbortController();
    this.inflightCtrl = ctrl;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.requestTimeoutMs);
    try {
      if (loadSandboxConfig().debugSandbox) {
        console.error(`[sandbox-debug] ${this.language} call ${method} ${path} url=${this.url} session=${this.sessionId ?? "(未创建)"}`);
      }
      const res = await fetch(`${this.url}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.secret ? { authorization: `Bearer ${this.secret}` } : {}),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: any = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { error: { code: EXECUTION_WIRE.errorCodes.backendUnavailable, message: text.slice(0, 200) } };
      }
      if (!res.ok) {
        const err = json.error as { code?: string; message?: string } | undefined;
        throw new SandboxKernelHttpError(err?.code ?? EXECUTION_WIRE.errorCodes.backendUnavailable, err?.message ?? `sandbox ${path} failed: ${res.status}`, res.status);
      }
      return json as T;
    } finally {
      clearTimeout(timer);
      if (this.inflightCtrl === ctrl) this.inflightCtrl = null;
    }
  }

  private async resolveGrant(): Promise<{ grant: SandboxExecutionGrant; taskId: string }> {
    if (!this.grant) throw new Error("SandboxKernel: execution grant required（P2-2——不再使用共享密钥）");
    const resolved = typeof this.grant === "function"
      ? await this.grant(this.language as "python" | "bash", this.grantContext ?? undefined)
      : this.grant;
    return { grant: resolved, taskId: this.grantContext?.taskId ?? resolved.lease.taskId };
  }

  private grantHeaders(grant: SandboxExecutionGrant): Record<string, string> {
    return { "x-sandbox-grant": sandboxGrantToHeader(grant) };
  }

  /** 创建会话（懒：宿主侧 kernel 进程首次 execute 才 spawn）。共享 promise 防并发双发泄漏 */
  private acquire(): Promise<void> {
    if (!this.acquirePromise) {
      this.acquirePromise = (async () => {
        if (this.sessionId) return;
        const { grant, taskId } = await this.resolveGrant();
        const r = await this.call<{ sessionId: string }>(
          "POST",
          EXECUTION_WIRE.paths.sessions,
          {},
          this.acquireTimeoutMs,
          { "x-sandbox-kernel-lang": this.language, ...this.grantHeaders(grant) },
        );
        this.sessionId = r.sessionId;
        this.cachedGrant = grant;
        this.sessionGrantTaskId = taskId;
      })().catch((e) => {
        // 失败不缓存 rejected promise（batch 反复崩时 acquire 排队超时 reject——
        // 后续 withSession await 同一 rejected promise 再抛 → 未 catch 处杀 batch）。
        this.acquirePromise = null;
        throw e;
      });
    }
    return this.acquirePromise;
  }

  private async withSession(): Promise<{ sessionId: string; grant: SandboxExecutionGrant }> {
    if (this.disposed) throw new Error("SandboxKernel disposed");
    if (!this.sessionId) await this.acquire();
    if (!this.sessionId || !this.cachedGrant) throw new Error("SandboxKernel: session creation failed");
    return { sessionId: this.sessionId, grant: this.cachedGrant };
  }

  /** 任务上下文切换：reset + release 旧会话（池条目状态清零——防跨任务 REPL 状态泄漏） */
  private async rebindForTask(): Promise<void> {
    if (!this.grantContext || !this.sessionGrantTaskId || this.grantContext.taskId === this.sessionGrantTaskId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.cachedGrant = null;
    this.acquirePromise = null;
    this.sessionGrantTaskId = null;
    if (!sessionId) return;
    try { await this.call("POST", `/sessions/${sessionId}/reset`, {}); } catch { /* 宿主不可达——释放兜底 */ }
    try { await this.call("POST", `/sessions/${sessionId}/release`, {}); } catch { /* 幂等兜底 */ }
  }

  private clearSession(): void {
    this.sessionId = null;
    this.cachedGrant = null;
    this.acquirePromise = null;
    this.sessionGrantTaskId = null;
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    let session: { sessionId: string; grant: SandboxExecutionGrant };
    try {
      await this.rebindForTask();
      session = await this.withSession();
    } catch (e) {
      if ((e as Error).message === "SandboxKernel disposed") {
        this.revive();
        session = await this.withSession(); // 重新创建会话（旧条目已归还/回收——池复用立即生效）
      } else throw e;
    }
    try {
      const wire = await this.call<{
        stdout?: string; stderr?: string; exitCode?: number | null; timedOut?: boolean;
        value?: unknown; truncated?: InterpreterResult["truncated"];
      }>(
        "POST",
        `/sessions/${session.sessionId}/execute`,
        {
          cmd: program,
          ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        },
        opts?.timeoutMs ?? this.requestTimeoutMs,
        {
          ...this.grantHeaders(session.grant),
          ...(opts?.exec ? { "x-sandbox-kernel-exec": opts.exec } : {}),
          ...(opts?.space ? { "x-sandbox-kernel-space": opts.space } : {}),
        },
      );
      const ok = (wire.exitCode ?? 0) === 0 && wire.timedOut !== true;
      return {
        ok,
        ...(wire.value !== undefined ? { value: wire.value } : {}),
        stdout: wire.stdout ?? "",
        stderr: wire.stderr ?? "",
        ...(!ok ? { error: { message: wire.stderr?.slice(0, 2_000) || `sandbox kernel exit ${wire.exitCode}`, code: "sandbox-kernel-error" } } : {}),
        durationMs: 0,
        language: this.language,
        ...(wire.truncated ? { truncated: wire.truncated } : {}),
      };
    } catch (e) {
      // Phase 3 条目 11：abort 触发的 AbortError → ok:false（其余错误照旧传播）
      if ((e as Error).name === "AbortError") {
        return { ok: false, error: { message: "sandbox kernel aborted", code: "aborted" }, durationMs: 0, language: this.language };
      }
      if (e instanceof SandboxKernelHttpError && (e.code === EXECUTION_WIRE.errorCodes.sessionExpired || e.code === EXECUTION_WIRE.errorCodes.notFound)) {
        this.clearSession();
      }
      throw e;
    }
  }

  async reset(): Promise<void> {
    const session = await this.withSession().catch((e) => {
      if ((e as Error).message === "SandboxKernel disposed") { this.revive(); return this.withSession(); }
      throw e;
    });
    await this.call("POST", `/sessions/${session.sessionId}/reset`, {}, undefined, this.grantHeaders(session.grant));
  }

  async snapshot(): Promise<InterpreterSnapshot> {
    const session = await this.withSession();
    const wire = await this.call<{ state?: InterpreterSnapshot }>(
      "POST",
      `/sessions/${session.sessionId}/snapshot`,
      {},
      undefined,
      this.grantHeaders(session.grant),
    );
    if (!wire.state) return { variables: [], functions: [], oversized: [] };
    return wire.state;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (loadSandboxConfig().debugSandbox) {
      console.error(`[sandbox-debug] ${this.language} disposed（调用方堆栈）\n${new Error().stack?.split("\n").slice(1, 6).join("\n")}`);
    }
    const sessionId = this.sessionId;
    if (!sessionId) return;
    // 有 in-flight 时不能 release（内核可能仍在执行）——走 abort（本地作废，池 TTL 回收）。
    if (this.inflightCtrl) {
      void this.abort();
      return;
    }
    // fire-and-forget：归还池（失败不阻塞——宿主不可达时环境已死）
    this.releasePromise = this.call("POST", `/sessions/${sessionId}/release`, {}).then(() => undefined, () => undefined);
    this.clearSession();
  }

  /** 自愈：disposed 后 execute 自动重建（重新创建会话） */
  private revive(): void {
    this.disposed = false;
    this.clearSession();
    this.releasePromise = null;
  }

  /** 等待 dispose 的 release 请求落地（测试/优雅关闭用——池复用立即生效） */
  async disposeAndFlush(): Promise<void> {
    this.dispose();
    await this.releasePromise;
  }

  /** 程序级制动：abort in-flight HTTP；本地会话立即作废且不 release——
   *  池条目绝不乐观复用（sandbox pool TTL 兜底回收）。下个 execute 自愈重新创建。 */
  async abort(): Promise<void> {
    this.inflightCtrl?.abort();
    this.clearSession();
    this.disposed = true;
    this.releasePromise = Promise.resolve();
  }
}
