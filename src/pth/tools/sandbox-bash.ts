/**
 * sandbox bash 转发工具（F/WP3 Task 11）
 *
 * 平台级替换内建 bash：以 SDK `customTools` 注册同名 `bash` 工具，HTTP 转发到 sandbox /exec。
 *
 * S2 硬约束（二轮评审 Important 2 + Spike S2 结论）：
 *  - 仅 customTools 同名注册（注册表后写覆盖即替换内建 bash）
 *  - 禁用 excludeTools+同名——会让 bash 整体消失
 *  - 对外接口名统一为 `bash`（不出现 sandbox-bash 第二套 API）
 *
 * 错误语义（不静默）：sandbox 不可达 → 类型化错误 `sandbox-unavailable`；
 * 超时 → `sandbox-timeout`（handler 以错误文本回传模型侧）。
 *
 * 密钥隔离：不转发 pth 进程 env（其中含 LLM 密钥——用户裁决 sandbox 不持 LLM 密钥）；
 * 转发仅 cmd/cwd/timeout，sandbox 以容器自身 env 执行。
 *
 * 流式说明：Task 10 已提供 SSE 端点（GET /exec/:id/stream）；本转发用非流式聚合后一次性
 * 返回（S2 实证 custom bash 走标准 tool_result，输出完整性优先——聚合返回不丢字节）。
 */

import { Type } from "@sinclair/typebox";

// ─── 类型化错误 ─────────────────────────────────────────────────────
export const SANDBOX_ERROR_UNAVAILABLE = "sandbox-unavailable";
export const SANDBOX_ERROR_TIMEOUT = "sandbox-timeout";

export type SandboxErrorCode = typeof SANDBOX_ERROR_UNAVAILABLE | typeof SANDBOX_ERROR_TIMEOUT;

export class SandboxForwardError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxForwardError";
  }
}

// ─── 类型 ────────────────────────────────────────────────────────────
export interface SandboxClientOptions {
  /** sandbox /exec 基址（compose：http://sandbox:8080） */
  baseUrl: string;
  /** 共享密钥（compose env SANDBOX_SHARED_SECRET 注入——非镜像硬编码） */
  secret: string;
  /** 客户端 HTTP 请求超时默认 ms（sandbox 侧 exec 超时 + 10s 余量优先于本值） */
  timeoutMs?: number;
}

export interface SandboxExecRequest {
  cmd: string | string[];
  cwd?: string;
  timeout?: number;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** AgentEngine 合并进 customTools 的最小约束（SDK ToolDefinition 形状） */
export interface SandboxBashDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: unknown;
  execute: (...args: any[]) => Promise<unknown>;
}

// ─── HTTP 转发客户端 ────────────────────────────────────────────────
export class SandboxExecClient {
  constructor(private opts: SandboxClientOptions) {}

  private requestTimeoutMs(req: SandboxExecRequest): number {
    if (typeof req.timeout === "number" && req.timeout > 0) return req.timeout + 10_000;
    return this.opts.timeoutMs ?? 120_000;
  }

  async exec(req: SandboxExecRequest, signal?: AbortSignal): Promise<SandboxExecResult> {
    const timeoutMs = this.requestTimeoutMs(req);
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), timeoutMs);
    abortTimer.unref?.();
    const onOuterAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onOuterAbort);
    try {
      const res = await fetch(`${this.opts.baseUrl}/exec`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.secret}`,
        },
        body: JSON.stringify({
          cmd: req.cmd,
          cwd: req.cwd,
          timeout: req.timeout,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new SandboxForwardError(SANDBOX_ERROR_UNAVAILABLE, `sandbox /exec failed: HTTP ${res.status} ${text}`);
      }
      return (await res.json()) as SandboxExecResult;
    } catch (err) {
      if (signal?.aborted) throw err; // 外部取消——保留 SDK 取消语义，不伪装成 unavailable
      if (ctrl.signal.aborted) {
        throw new SandboxForwardError(SANDBOX_ERROR_TIMEOUT, `sandbox /exec timed out after ${timeoutMs}ms`);
      }
      if (err instanceof SandboxForwardError) throw err;
      throw new SandboxForwardError(SANDBOX_ERROR_UNAVAILABLE, `sandbox unreachable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(abortTimer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

// ─── SDK ToolDefinition 工厂 ────────────────────────────────────────
/**
 * 同名 `bash` 的 SDK 自定义工具定义。execute 转发 sandbox /exec 并聚合回传
 * （输出完整性优先，S2）；错误以类型化标记文本回传模型侧。
 */
export function createSandboxBashDefinition(client: SandboxExecClient): SandboxBashDefinition {
  return {
    name: "bash",
    label: "Bash (sandbox)",
    description:
      "Run a bash command in the isolated code-execution sandbox. The sandbox has no network access " +
      "and operates on the shared workspaces volume (/data/workspaces).",
    promptSnippet: "Executes shell commands in an isolated sandbox (no network).",
    parameters: Type.Object({
      command: Type.String(),
      timeout: Type.Optional(Type.Number()),
    }),
    execute: async (
      _toolCallId: string,
      params: { command: string; timeout?: number },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd?: string } | undefined,
    ): Promise<unknown> => {
      try {
        const result = await client.exec({ cmd: params.command, cwd: ctx?.cwd, timeout: params.timeout }, signal);
        if (result.timedOut) {
          return {
            content: [
              {
                type: "text",
                text: `${SANDBOX_ERROR_TIMEOUT}: command killed after ${params.timeout ?? "default"}ms timeout`,
              },
            ],
            details: { exitCode: result.exitCode, stderr: result.stderr },
          };
        }
        const output = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n");
        return {
          content: [{ type: "text", text: output || "(no output)" }],
          details: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
        };
      } catch (err) {
        if (err instanceof SandboxForwardError) {
          return { content: [{ type: "text", text: `${err.code}: ${err.message}` }], details: { code: err.code } };
        }
        if (signal?.aborted) throw err; // 工具被取消——上抛由 SDK 处理
        return {
          content: [
            {
              type: "text",
              text: `${SANDBOX_ERROR_UNAVAILABLE}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {},
        };
      }
    },
  };
}
