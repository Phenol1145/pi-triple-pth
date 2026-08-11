/**
 * sandbox-compiled-kernel.ts — PTH 侧 SandboxCompiledKernel 适配器（编译核 Phase B）
 *
 * 实现统一 Interpreter 接口（execute/dispose——编译核无持久状态），把编译+运行
 * 转发到 sandbox 侧 kernel 宿主（POST /kernel/compiled）。上层（任务代码/KernelManager）
 * 零改动。C/Rust 等编译型 kernel 只在 sandbox 运行（主容器无编译器——用户架构裁决）。
 *
 * 安全：与 sandbox 通信仅携带共享密钥；编译器变体白名单（gcc/clang/tcc）；每次调用
 *       独立临时工作区（编译-运行管道——天然隔离，宿主侧清理）。
 */

import type { ExecuteOptions, Interpreter, InterpreterResult } from "./types.js";

export interface SandboxCompiledKernelOptions {
  /** sandbox 宿主 base URL（如 http://sandbox:8080） */
  url: string;
  /** 共享密钥（SANDBOX_SHARED_SECRET 同源） */
  secret: string;
  /** 编译器变体（gcc|clang|tcc——缺省 auto） */
  cc?: "gcc" | "clang" | "tcc";
  /** 请求超时（默认 65s——编译+运行） */
  requestTimeoutMs?: number;
}

export class SandboxCompiledKernel implements Interpreter {
  readonly language = "c";
  readonly state: Record<string, unknown> = {};   // 编译核无持久状态
  private url: string;
  private secret: string;
  private cc?: "gcc" | "clang" | "tcc";
  private requestTimeoutMs: number;

  constructor(opts: SandboxCompiledKernelOptions) {
    this.url = opts.url.replace(/\/$/, "");
    this.secret = opts.secret;
    this.cc = opts.cc;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 65_000;
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.requestTimeoutMs);
      try {
        const res = await fetch(`${this.url}/kernel/compiled`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.secret}`,
          },
          body: JSON.stringify({ code: program, cc: this.cc, timeoutMs: opts?.timeoutMs, buildOnly: opts?.buildOnly === true }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return { ok: false, error: { message: `compiled kernel HTTP ${res.status}: ${body.slice(0, 300)}` }, durationMs: Date.now() - start };
        }
        const result = (await res.json()) as InterpreterResult;
        return { ...result, durationMs: result.durationMs ?? Date.now() - start };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return { ok: false, error: { message: `compiled kernel error: ${(e as Error).message}` }, durationMs: Date.now() - start };
    }
  }

  /** 编译核无持久状态——no-op（接口兼容） */
  reset(): void {}
  dispose(): void {}
  async snapshot(): Promise<import("./types.js").InterpreterSnapshot> {
    return { variables: [], functions: [], oversized: [] };
  }
}
