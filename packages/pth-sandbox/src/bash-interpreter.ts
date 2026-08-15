import type { ExecuteOptions, Interpreter, InterpreterResult } from "./kernel/interpreter/types.js";
import type { SandboxExecClient, SandboxExecRequest, SandboxExecResult } from "./sandbox-bash.js";

export const DEFAULT_BASH_CWD = "/data/workspaces";

/**
 * sandbox exec 结果（适配说明）：真实 SandboxExecClient 返回 {stdout,stderr,exitCode,timedOut}
 * （无 ok/durationMs）；brief/coordinator 假定接口含 ok/durationMs。本解释器兼容两种形状：
 * ok 显式给出时直接采用，否则以 exitCode===0 推导（timeout→exitCode null→ok=false）。
 */
type SandboxExecResultLike = SandboxExecResult & { ok?: boolean; durationMs?: number };

/**
 * bash 解释器：持久 shell 会话（v1 状态传递近似）。
 * 隔离 = sandbox 容器（不可信代码经 sandbox /exec 转发）。
 * 持久状态：cwd/env 在命令间传递（真 pty 留 v2）。
 */
export class BashInterpreter implements Interpreter {
  readonly language = "bash";
  // 适配说明：brief 原实现字段名 `state` 与 getter `get state()` 同名（TS2300 duplicate
  // identifier，无法编译）——私有可变会话字段改名 `session`，公开只读 state 由 getter 提供。
  private session = { cwd: DEFAULT_BASH_CWD, env: {} as Record<string, string> };

  constructor(private deps: { sandbox: Pick<SandboxExecClient, "exec">; cwdWhitelist?: string[] }) {}

  get state(): Record<string, unknown> {
    return this.session as unknown as Record<string, unknown>;
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const start = Date.now();
    const cwd = opts?.cwd ?? this.session.cwd;
    const cmd = `cd ${cwd} && ${program}`;
    try {
      // 适配说明：真实 SandboxExecRequest 为 {cmd,cwd?,timeout?}（无 timeoutMs/env）——
      // 以 `timeout` 转发超时（SandboxExecClient 读取 req.timeout）；env 合并保留 v1 状态
      // 传递设计（coordinator 接口含 env；真实 client 忽略该字段，无害）。
      const req = {
        cmd,
        cwd,
        timeout: opts?.timeoutMs ?? 300_000,
        env: { ...this.session.env, ...(opts?.env ?? {}) },
      } as SandboxExecRequest;
      const raw = await this.deps.sandbox.exec(req);
      const res = raw as SandboxExecResultLike;
      this.session.cwd = cwd;
      return {
        ok: res.ok ?? res.exitCode === 0,
        stdout: res.stdout,
        stderr: res.stderr,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      const err = e as Error & { code?: string };
      // Finding #2 修复：真实 SandboxExecClient 在 sandbox 不可达/超时时抛 SandboxForwardError
      // （code = sandbox-unavailable / sandbox-timeout）——结构化 code 随 error 字段透出，
      // 调用方据此区分不可达与超时（不可仅凭 message 字符串判断）。无 code 字段时保持 v1 形状。
      const error: InterpreterResult["error"] = { message: err.message, stack: err.stack };
      if (err.code) error.code = err.code;
      return { ok: false, error, durationMs: Date.now() - start };
    }
  }

  snapshot() {
    // 会话配置（cwd/env）——非知识型状态，v1 不进持久化快照
    return { variables: [], functions: [], oversized: [] };
  }

  reset(): void {
    this.session = { cwd: DEFAULT_BASH_CWD, env: {} };
  }

  dispose(): void {}
}
