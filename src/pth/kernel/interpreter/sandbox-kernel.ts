/**
 * sandbox-kernel.ts — PTH 侧 SandboxKernel 适配器（kernel sandbox SPEC §3.3）
 *
 * 实现统一 Interpreter 接口（execute/reset/snapshot/dispose），把调用转发到
 * sandbox 侧 kernel 宿主（HTTP）。上层（agent 循环/任务代码/KernelManager）零改动。
 *
 * 安全：与 sandbox 通信仅携带共享密钥（SANDBOX_SHARED_SECRET）；不注入业务密钥；
 *       execute 请求体无 env 字段（宿主 400 拒绝——敏感信息约束）。
 */

import type { ExecuteOptions, Interpreter, InterpreterResult, InterpreterSnapshot } from "./types.js";

export interface SandboxKernelOptions {
  /** sandbox 宿主 base URL（如 http://sandbox:8080） */
  url: string;
  /** 共享密钥（SANDBOX_SHARED_SECRET 同源） */
  secret: string;
  /** python | bash */
  language: "python" | "bash";
  /** 构造时 acquire（默认 true）；false 供测试注入已有 kernelId */
  acquireOnInit?: boolean;
  kernelId?: string;
  /** 超时保护（fetch 层，默认 10s——宿主内部有执行超时） */
  requestTimeoutMs?: number;
  /** acquire 排队等待上限（池满时 FIFO 排队——默认 60s） */
  acquireTimeoutMs?: number;
}

export class SandboxKernel implements Interpreter {
  readonly language: string;
  /** 远程状态经 execute/snapshot 访问——本地同步读返回空 */
  readonly state: Record<string, unknown> = {};
  private url: string;
  private secret: string;
  private kernelId: string | null;
  private requestTimeoutMs: number;
  private acquireTimeoutMs: number;
  private disposed = false;
  private releasePromise: Promise<void> | null = null;
  private acquirePromise: Promise<void> | null = null;
  /** 池条目分配完成的 promise（测试/依赖方等待用——懒 acquire 异步） */
  get ready(): Promise<void> {
    return this.acquire();
  }

  constructor(opts: SandboxKernelOptions) {
    this.language = opts.language;
    this.url = opts.url.replace(/\/+$/, "");
    this.secret = opts.secret;
    this.kernelId = opts.kernelId ?? null;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 60_000;
    if (opts.acquireOnInit !== false) {
      // 懒获取：失败不炸构造（宿主暂不可达/池满排队）——后续 execute 时重试
      void this.acquire().catch(() => {});
    }
  }

  private async call<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.requestTimeoutMs);
    try {
      const res = await fetch(`${this.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.secret}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: any = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { error: text.slice(0, 200) };
      }
      if (!res.ok) {
        throw new Error(json.error ?? `sandbox ${path} failed: ${res.status}`);
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 分配池条目（懒：宿主侧 kernel 进程首次 execute 才 spawn）。共享 promise 防并发双发泄漏 */
  private acquire(): Promise<void> {
    if (!this.acquirePromise) {
      this.acquirePromise = (async () => {
        if (this.kernelId) return;
        const r = await this.call<{ kernelId: string }>("/kernel/acquire", { lang: this.language }, this.acquireTimeoutMs);
        this.kernelId = r.kernelId;
      })();
    }
    return this.acquirePromise;
  }

  private async withKernelId(): Promise<string> {
    if (this.disposed) throw new Error("SandboxKernel disposed");
    if (!this.kernelId) await this.acquire();
    return this.kernelId!;
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const kernelId = await this.withKernelId();
    return this.call<InterpreterResult>("/kernel/execute", {
      kernelId,
      code: program,
      ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  async reset(): Promise<void> {
    const kernelId = await this.withKernelId();
    await this.call("/kernel/reset", { kernelId });
  }

  async snapshot(): Promise<InterpreterSnapshot> {
    const kernelId = await this.withKernelId();
    return this.call<InterpreterSnapshot>("/kernel/snapshot", { kernelId });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const kernelId = this.kernelId;
    if (kernelId) {
      // fire-and-forget：归还池（失败不阻塞——宿主不可达时环境已死）
      this.releasePromise = this.call("/kernel/release", { kernelId }).then(() => undefined, () => undefined);
    }
  }

  /** 等待 dispose 的 release 请求落地（测试/优雅关闭用——池复用立即生效） */
  async disposeAndFlush(): Promise<void> {
    this.dispose();
    await this.releasePromise;
  }
}
