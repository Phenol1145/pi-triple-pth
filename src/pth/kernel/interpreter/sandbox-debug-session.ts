/**
 * sandbox-debug-session.ts — PTH 侧 SandboxDebugSession 适配器（调试协议 Phase 2）
 *
 * 实现 DebugSession 接口（attach/breakpoint/continue/step/stack/variables/evaluate/detach），
 * 把调用转发到 sandbox 侧 kernel-host 的 /kernel/debug/* 端点。上层（agent 循环/任务代码）
 * 零改动——debug 核在 sandbox 运行（gdb 工具链），主容器无 gdb。
 *
 * 会话模型：attach 创建会话（sessionId）→ 后续操作带 sessionId → detach 销毁。
 * 安全：仅携带共享密钥；cc 变体白名单；sandbox 侧会话 idle 清理（30min）防泄漏。
 */

import type {
  DebugSession, DebugBreakpoint, DebugStopped, DebugStackFrame, DebugVariable, DebugEvent, DebugSnapshot,
} from "./types.js";

export interface SandboxDebugSessionOptions {
  /** sandbox 宿主 base URL（如 http://sandbox:8080） */
  url: string;
  /** 共享密钥（SANDBOX_SHARED_SECRET 同源） */
  secret: string;
  /** 编译器变体（gcc|clang|tcc——缺省 auto） */
  cc?: "gcc" | "clang" | "tcc";
  /** 请求超时（默认 30s——gdb 操作一般秒级） */
  requestTimeoutMs?: number;
  /** 会话 ID（attach 后填充——测试可注入已有会话） */
  sessionId?: string;
  onEvent?: (e: DebugEvent) => void;
}

export class SandboxDebugSession implements DebugSession {
  readonly language = "c";
  onEvent?: (e: DebugEvent) => void;
  private url: string;
  private secret: string;
  private cc?: "gcc" | "clang" | "tcc";
  private requestTimeoutMs: number;
  private _id: string;

  constructor(opts: SandboxDebugSessionOptions) {
    this.url = opts.url.replace(/\/$/, "");
    this.secret = opts.secret;
    this.cc = opts.cc;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this._id = opts.sessionId ?? "";
    this.onEvent = opts.onEvent;
  }

  get id(): string { return this._id; }

  private async call<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.requestTimeoutMs);
    try {
      const res = await fetch(`${this.url}/kernel/debug/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.secret}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`debug HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as Record<string, unknown>;
      if ((data as { error?: unknown }).error) throw new Error(String((data as { error: unknown }).error));
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async attach(source: string): Promise<void> {
    const r = await this.call<{ sessionId: string }>("attach", { code: source, cc: this.cc });
    this._id = r.sessionId;
    this.onEvent?.({ type: "attach", sessionId: this._id, ts: Date.now() });
  }

  async setBreakpoint(line: number, condition?: string): Promise<DebugBreakpoint> {
    this.onEvent?.({ type: "breakpoint-set", sessionId: this._id, ts: Date.now(), detail: { line } });
    return await this.call<DebugBreakpoint>("breakpoint", { sessionId: this._id, line, condition });
  }

  async continueExec(): Promise<DebugStopped> {
    return await this.call<DebugStopped>("continue", { sessionId: this._id });
  }

  async step(direction: "into" | "over" | "out"): Promise<DebugStopped> {
    return await this.call<DebugStopped>("step", { sessionId: this._id, direction });
  }

  async snapshot(): Promise<DebugSnapshot> {
    return await this.call<DebugSnapshot>("snapshot", { sessionId: this._id });
  }

  async stack(): Promise<DebugStackFrame[]> {
    return await this.call<DebugStackFrame[]>("stack", { sessionId: this._id });
  }

  async variables(frameId?: number): Promise<DebugVariable[]> {
    return await this.call<DebugVariable[]>("variables", { sessionId: this._id, frameId });
  }

  async evaluate(expr: string, frameId?: number): Promise<{ value: string }> {
    return await this.call<{ value: string }>("evaluate", { sessionId: this._id, expr, frameId });
  }

  async detach(): Promise<void> {
    if (!this._id) return;
    try {
      await this.call<{ ok: boolean }>("detach", { sessionId: this._id });
    } finally {
      this._id = "";
    }
  }
}
