/**
 * execution/adapters/sandbox-execution-adapter.ts — sandbox HTTP 执行适配器（模块化 v2 P2-1）。
 *
 * 把 ExecutionPort 落到 sandbox `/kernel/execute`：body 只携带 grant + request；
 * 不读取/不携带 SANDBOX_SHARED_SECRET 作为执行认证（P2-2 由 sandbox grant verifier 校验）。
 * 非 2xx 统一映射为 ok:false + error，不让 adapter 调用方看到裸 HTTP 细节。
 */

import type { ExecutionGrant, ExecutionPort, ExecutionRequest, ExecutionResult } from "../../contracts/index.js";

export interface SandboxExecutionAdapterOptions {
  baseUrl: string;
  /** 测试注入（缺省 globalThis.fetch） */
  fetchImpl?: typeof fetch;
  /** execute 请求超时（缺省 5s——transport deadline 由 P2-3 与 grant deadline 联动） */
  timeoutMs?: number;
}

export function createSandboxExecutionAdapter(opts: SandboxExecutionAdapterOptions): ExecutionPort {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function execute(request: ExecutionRequest, grant: ExecutionGrant, signal?: AbortSignal): Promise<ExecutionResult> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetchImpl(`${base}/kernel/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant, request }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, stdout: "", stderr: "", durationMs: 0, error: { code: "sandbox-http", message: `sandbox execute HTTP ${res.status}: ${text.slice(0, 300)}` } };
      }
      const body = (await res.json()) as { result?: ExecutionResult };
      if (!body || typeof body !== "object" || !("result" in body)) {
        return { ok: false, stdout: "", stderr: "", durationMs: 0, error: { code: "sandbox-shape", message: "sandbox execute response missing result" } };
      }
      return body.result as ExecutionResult;
    } catch (e) {
      return { ok: false, stdout: "", stderr: "", durationMs: 0, error: { code: "sandbox-unreachable", message: e instanceof Error ? e.message : String(e) } };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return { execute };
}
