/**
 * sandbox-kernel.ts —— PTH 侧 SandboxKernel 适配器（kernel sandbox SPEC §3.3）
 *
 * 实现统一 Interpreter 接口（execute/reset/snapshot/dispose），把调用转发到
 * sandbox 侧 kernel 宿主（HTTP）。上层（agent 循环/任务代码/KernelManager）零改动。
 *
 * 安全：与 sandbox 通信仅携带共享密钥（SANDBOX_SHARED_SECRET）；不注入业务密钥；
 *       execute 请求体无 env 字段（宿主 400 拒绝——敏感信息约束）。
 * P0-4：acquire 后只持有 opaque SandboxLease；所有操作按 lease id+generation 校验；
 *       kernelId 已从协议退役。
 */

import type { SandboxLease } from "./kernel-lease.js";
import type { ExecuteOptions, Interpreter, InterpreterResult, InterpreterSnapshot } from "./kernel/interpreter/types.js";

export interface SandboxKernelOptions {
  /** sandbox 宿主 base URL（如 http://sandbox:8080） */
  url: string;
  /** 共享密钥（SANDBOX_SHARED_SECRET 同源） */
  secret: string;
  /** python | bash */
  language: "python" | "bash";
  /** 构造时 acquire（默认 true）；false 供测试注入已有 lease */
  acquireOnInit?: boolean;
  lease?: SandboxLease;
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
  private lease: SandboxLease | null;
  private requestTimeoutMs: number;
  private acquireTimeoutMs: number;
  private disposed = false;
  private releasePromise: Promise<void> | null = null;
  private acquirePromise: Promise<void> | null = null;
  /** in-flight HTTP 请求控制器（Phase 3 条目 11——abort 终止执行中的 /kernel/execute 或 acquire） */
  private inflightCtrl: AbortController | null = null;
  /** 池条目分配完成的 promise（测试/依赖方等待用——懒 acquire 异步） */
  get ready(): Promise<void> {
    return this.acquire();
  }

  constructor(opts: SandboxKernelOptions) {
    this.language = opts.language;
    this.url = opts.url.replace(/\/+$/, "");
    this.secret = opts.secret;
    this.lease = opts.lease ?? null;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 60_000;
    if (opts.acquireOnInit !== false) {
      // 懒获取：失败不炸构造（宿主暂不可达/池满排队）——后续 execute 时重试
      void this.acquire().catch(() => {});
    }
  }

  private async call<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const ctrl = new AbortController();
    this.inflightCtrl = ctrl;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.requestTimeoutMs);
    try {
      // debug: 记录 sandbox 调用（URL/路径——诊断 abort 来源）
      if (process.env.PTH_DEBUG_SANDBOX) console.error(`[sandbox-debug] ${this.language} call ${path} url=${this.url} timeout=${timeoutMs ?? this.requestTimeoutMs}ms lease=${this.lease?.id ?? "(未acquire)"}`);
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
      if (this.inflightCtrl === ctrl) this.inflightCtrl = null;
    }
  }

  /** 分配池条目（懒：宿主侧 kernel 进程首次 execute 才 spawn）。共享 promise 防并发双发泄漏 */
  private acquire(): Promise<void> {
    if (!this.acquirePromise) {
      this.acquirePromise = (async () => {
        if (this.lease) return;
        const r = await this.call<{ lease: SandboxLease }>("/kernel/acquire", { lang: this.language }, this.acquireTimeoutMs);
        this.lease = r.lease;
      })().catch((e) => {
        // 失败不缓存 rejected promise（batch 反复崩时 acquire 排队超时 reject——
        // 后续 withLease await 同一 rejected promise 再抛 → 未 catch 处杀 batch）。
        // 重置：下次调用重新 acquire（sandbox 恢复后自动重连）。
        this.acquirePromise = null;
        throw e;
      });
    }
    return this.acquirePromise;
  }

  private async withLease(): Promise<SandboxLease> {
    if (this.disposed) throw new Error("SandboxKernel disposed");
    if (!this.lease) await this.acquire();
    return this.lease!;
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    let lease: SandboxLease;
    try {
      lease = await this.withLease();
    } catch (e) {
      if ((e as Error).message === "SandboxKernel disposed") {
        this.revive();
        lease = await this.withLease();   // 重新 acquire（旧条目已 release——池复用立即生效）
      } else throw e;
    }
    try {
      return await this.call<InterpreterResult>("/kernel/execute", {
        lease,
        code: program,
        ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts?.exec ? { exec: opts.exec } : {}),   // 元命令拆分（2026-08-11）：single/program 透传 sandbox
        ...(opts?.space ? { space: opts.space } : {}),   // 记忆桥盖章（2026-08-12 批 3）透传
      });
    } catch (e) {
      // Phase 3 条目 11：abort 触发的 AbortError → ok:false（其余错误照旧传播）
      if ((e as Error).name === "AbortError") {
        return { ok: false, error: { message: "sandbox kernel aborted", code: "aborted" }, durationMs: 0, language: this.language };
      }
      throw e;
    }
  }

  async reset(): Promise<void> {
    const lease = await this.withLease().catch((e) => {
      if ((e as Error).message === "SandboxKernel disposed") { this.revive(); return this.withLease(); }
      throw e;
    });
    await this.call("/kernel/reset", { lease });
  }

  async snapshot(): Promise<InterpreterSnapshot> {
    const lease = await this.withLease();
    try {
      return await this.call<InterpreterSnapshot>("/kernel/snapshot", { lease });
    } catch (e) {
      // 幂等重试 1 次（abort/瞬时故障——sandbox 恢复后自动成功）
      return await this.call<InterpreterSnapshot>("/kernel/snapshot", { lease });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 诊断（2026-08-12 复测发现）：dispose 来源追踪——PTH_DEBUG_SANDBOX 门控
    if (process.env.PTH_DEBUG_SANDBOX) {
      console.error(`[sandbox-debug] ${this.language} disposed（调用方堆栈）\n${new Error().stack?.split("\n").slice(1, 6).join("\n")}`);
    }
    const lease = this.lease;
    if (lease) {
      // fire-and-forget：归还池（失败不阻塞——宿主不可达时环境已死）
      this.releasePromise = this.call("/kernel/release", { lease }).then(() => undefined, () => undefined);
    }
  }

  /** 自愈（2026-08-12 复测发现）：disposed 后 execute 自动重建（重新 acquire 池条目）——
   * 否则 dispose 事件（batch shutdown 竞态/重启路径）后 worker 的 python 永久不可用，
   * agent 反复失败重试拖慢任务（复测窗口 5x 慢的根因） */
  private revive(): void {
    this.disposed = false;
    this.lease = null;
    this.acquirePromise = null;
    this.releasePromise = null;
  }

  /** 等待 dispose 的 release 请求落地（测试/优雅关闭用——池复用立即生效） */
  async disposeAndFlush(): Promise<void> {
    this.dispose();
    await this.releasePromise;
  }

  /** 程序级制动（2026-08-14 A1 Phase 3 条目 11）：abort in-flight HTTP（execute/acquire 即时报错）
   *  → dispose 归还租约（宿主侧杀进程终止程序）→ await release 落地。
   *  本核此后 disposed——下个 execute 自愈 revive（重新 acquire——池复用立即生效）。 */
  async abort(): Promise<void> {
    this.inflightCtrl?.abort();
    this.dispose();
    await this.releasePromise;
  }
}
