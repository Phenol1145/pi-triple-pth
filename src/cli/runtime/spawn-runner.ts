/**
 * cli/runtime/spawn-runner.ts —— pth CLI runtime 公共 spawn runner。
 *
 * 收敛 runtime-doctor 与 runtime-orchestrator 两份逐字节近同的 defaultRunner：
 * 唯一差异是 orchestrator 支持 env 透传；统一实现同时兼容两者（doctor 不传 env 时行为不变）。
 */
import { spawn } from "node:child_process";

export interface SpawnRunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
}

export interface SpawnRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnRunner = (
  cmd: string,
  argv: string[],
  opts?: SpawnRunOptions,
) => Promise<SpawnRunResult>;

export function createSpawnRunner(): SpawnRunner {
  return (cmd, argv, opts) =>
    new Promise<SpawnRunResult>((resolvePromise) => {
      const child = spawn(cmd, argv, {
        stdio: ["pipe", "pipe", "pipe"],
        ...(opts?.env ? { env: opts.env } : {}),
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", (e) => resolvePromise({ code: -1, stdout, stderr: String(e.message ?? e) }));
      child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
      if (opts?.input !== undefined) child.stdin?.end(opts.input);
      else child.stdin?.end();
    });
}
