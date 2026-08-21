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

import { ExecutionClientError, HttpExecutionClient } from "@away_from/shared/execution";

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
  /** 健康监控（F/WP3 Task 13）：记录连续转发失败/成功，驱动 degraded 状态。可选。 */
  monitor?: SandboxHealthMonitor;
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

// ─── 失效降级监控（F/WP3 Task 13）────────────────────────────────────
export interface SandboxHealthOptions {
  /** 连续转发失败阈值（默认 3）。main.ts 以 env SANDBOX_DEGRADED_THRESHOLD 覆盖。 */
  failureThreshold?: number;
  /** 默认探活的 sandbox 基址（fetch <baseUrl>/health；测试可改注入 probe） */
  baseUrl?: string;
  /** degraded 后自动探活间隔 ms（默认 15000）——定时器 unref，不阻塞进程退出 */
  probeIntervalMs?: number;
  /** /health 探活超时 ms（默认 2000） */
  probeTimeoutMs?: number;
  /** 探活实现（默认 fetch <baseUrl>/health；测试注入 stub） */
  probe?: () => Promise<boolean>;
  /** 状态变更回调：degraded 进入（true）/退出（false）——main.ts 接线审计事件+日志 */
  onStateChange?: (degraded: boolean, consecutiveFailures: number) => void;
}

/**
 * sandbox 失效降级监控：连续 N 次转发失败（sandbox-unavailable）→ degraded；
 * 成功或定期探活（/health）通过 → 自动清除。
 * 设计裁决：仅 `sandbox-unavailable`（不可达/非 2xx）计入失败；`sandbox-timeout`
 * 表示 sandbox 可达但命令慢，不计入降级（探活以 /health 为准）。
 */
export class SandboxHealthMonitor {
  private consecutiveFailures = 0;
  private degraded = false;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private opts: SandboxHealthOptions = {}) {}

  get threshold(): number {
    return this.opts.failureThreshold ?? 3;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /** 转发失败 → 连续计数；达阈值进入 degraded 并启动自动探活 */
  recordFailure(): void {
    if (this.disposed) return;
    this.consecutiveFailures++;
    if (!this.degraded && this.consecutiveFailures >= this.threshold) {
      this.degraded = true;
      this.opts.onStateChange?.(true, this.consecutiveFailures);
      this.scheduleProbe();
    }
  }

  /** 转发成功 → 清零；若已 degraded 则退出（自动恢复） */
  recordSuccess(): void {
    if (this.disposed) return;
    this.consecutiveFailures = 0;
    if (this.degraded) this.clearDegraded();
  }

  /** 立即探活一次（定时器与测试共用）——通过则清除 degraded */
  async probeNow(): Promise<boolean> {
    if (this.disposed) return false;
    const ok = await this.runProbe();
    if (ok && this.degraded) this.clearDegraded();
    return ok;
  }

  /** 停探活定时器（进程退出/测试清理） */
  dispose(): void {
    this.disposed = true;
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private clearDegraded(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.consecutiveFailures = 0;
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    this.opts.onStateChange?.(false, 0);
  }

  /** degraded 期间周期性探活（递归 setTimeout + unref——不阻塞退出） */
  private scheduleProbe(): void {
    if (this.probeTimer || !this.degraded || this.disposed) return;
    this.probeTimer = setTimeout(async () => {
      this.probeTimer = null;
      const ok = await this.runProbe();
      if (ok) {
        if (this.degraded) this.clearDegraded();
      } else if (this.degraded && !this.disposed) {
        this.scheduleProbe();
      }
    }, this.opts.probeIntervalMs ?? 15_000);
    this.probeTimer.unref?.();
  }

  private async runProbe(): Promise<boolean> {
    if (this.opts.probe) return this.opts.probe();
    const baseUrl = this.opts.baseUrl ?? "";
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.opts.probeTimeoutMs ?? 2000);
      t.unref?.();
      const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ─── HTTP 转发客户端（execution/v1）───────────────────────────────
export class SandboxExecClient {
  private readonly client: HttpExecutionClient;
  constructor(private opts: SandboxClientOptions) {
    this.client = new HttpExecutionClient({ baseUrl: this.opts.baseUrl, token: this.opts.secret });
  }

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
      const result = await this.client.execute(
        { cmd: req.cmd, cwd: req.cwd, timeoutMs: req.timeout },
        ctrl.signal,
      );
      // 转发成功 → 清零连续失败；若已 degraded 则自动恢复（F/WP3 Task 13）
      this.opts.monitor?.recordSuccess();
      return result;
    } catch (err) {
      if (signal?.aborted) throw err; // 外部取消——保留 SDK 取消语义，不伪装成 unavailable
      if (ctrl.signal.aborted) {
        // 超时不计入降级（sandbox 可达但慢）；探活以 /health 为准
        throw new SandboxForwardError(SANDBOX_ERROR_TIMEOUT, `sandbox /exec timed out after ${timeoutMs}ms`);
      }
      const message = err instanceof ExecutionClientError
        ? `sandbox /exec failed: HTTP ${err.status ?? "?"} ${err.message}`
        : `sandbox unreachable: ${err instanceof Error ? err.message : String(err)}`;
      this.opts.monitor?.recordFailure();
      throw new SandboxForwardError(SANDBOX_ERROR_UNAVAILABLE, message);
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
