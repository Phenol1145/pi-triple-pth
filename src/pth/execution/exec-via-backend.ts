/**
 * exec-via-backend.ts —— PTH 调用方迁移 execution/v1 的公共桥。
 *
 * 旧 execPrefix（docker exec 前缀）解析为 DockerExecBackend；无前缀为 LocalBackend。
 * 每个 professional adapter 的 exec/execPrefix 构造参数保持兼容，内部统一经
 * ExecutionBackend.execute 执行——各 adapter 不再维护自己的 spawn 副本。
 */

import {
  DockerExecBackend,
  LocalBackend,
  type ExecutionBackend,
  type ExecutionCapabilities,
  type ExecutionRequest,
} from "@away_from/shared/execution";

export interface AdapterExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface AdapterExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  error?: string;
}

export type AdapterExecFn = (
  cmd: string,
  args: readonly string[],
  opts?: AdapterExecOptions,
) => Promise<AdapterExecResult>;

/** 协议输出上限 4MB；旧 adapter 更大的 cap 收敛到协议上限。 */
const MAX_PROTOCOL_OUTPUT = 4 * 1024 * 1024;

function backendFromDockerExecPrefix(prefix: readonly string[]): ExecutionBackend {
  const rest = prefix.slice(2); // 去掉 ["docker","exec"]
  if (rest.length === 0) throw new Error(`invalid docker exec prefix: ${prefix.join(" ")}`);
  const containerName = rest[rest.length - 1]!;
  const head = rest.slice(0, -1);
  const envDefaults: Record<string, string> = {};
  for (let i = 0; i + 1 < head.length; i += 1) {
    if (head[i] === "-e" && typeof head[i + 1] === "string") {
      const pair = head[i + 1]!;
      const eq = pair.indexOf("=");
      if (eq > 0) envDefaults[pair.slice(0, eq)] = pair.slice(eq + 1);
      i += 1;
    }
  }
  const inner = new DockerExecBackend({ containerName });
  return {
    id: `docker-exec:${containerName}`,
    getCapabilities: (): Promise<ExecutionCapabilities> => inner.getCapabilities(),
    execute: (req: ExecutionRequest): ReturnType<ExecutionBackend["execute"]> =>
      inner.execute({ ...req, env: { ...envDefaults, ...(req.env ?? {}) } }),
  };
}

/** 旧 execPrefix → execution/v1 backend；无前缀 → LocalBackend（生产容器内直跑）。 */
export function executionBackendFromPrefix(prefix?: readonly string[]): ExecutionBackend {
  if (!prefix || prefix.length === 0) return new LocalBackend();
  if (prefix[0] === "docker" && prefix[1] === "exec") return backendFromDockerExecPrefix(prefix);
  throw new Error(`unsupported execPrefix (migrate to ExecutionBackend): ${prefix.join(" ")}`);
}

/** backend.execute → adapter 通用结果。 */
export function execViaBackend(backend: ExecutionBackend): AdapterExecFn {
  return async (cmd, args, opts = {}) => {
    try {
      const outputCap = Math.min(opts.maxOutputBytes ?? MAX_PROTOCOL_OUTPUT, MAX_PROTOCOL_OUTPUT);
      const result = await backend.execute({
        cmd: [cmd, ...args],
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        maxStdoutBytes: outputCap,
        maxStderrBytes: outputCap,
      });
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.exitCode,
        timedOut: result.timedOut,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, stdout: "", stderr: message, code: null, timedOut: false, error: message };
    }
  };
}
