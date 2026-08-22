/**
 * execution/local-exec-server.ts —— P2 本地执行器（PTH 产品面，Lean 首期参考实现）。
 *
 * 直接复用 shared `ExecutionHttpServer`（HTTP+WS、模式路由、Bearer 常数时间比较、
 * 结构化错误信封）：
 *  - 只监听 127.0.0.1（默认）；engine 容器经 host.docker.internal 访问；
 *  - LOCAL_EXEC_SHARED_SECRET 必填（缺失 fail-closed，/health 免认证）；
 *  - profile 固定 host；pathMapping 只接受已登记映射。
 */

import {
  ExecutionHttpServer,
  type ExecutionPathMapping,
} from "@away_from/shared/execution";
import { LocalSpawnBackend, type LocalSpawnBackendOptions } from "./backends/local-spawn-backend.js";

export interface LocalExecServerOptions {
  token: string;
  host?: string;
  port?: number;
  mappings?: readonly ExecutionPathMapping[];
  defaultTimeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface RunningLocalExecServer {
  server: ExecutionHttpServer;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startLocalExecServer(options: LocalExecServerOptions): Promise<RunningLocalExecServer> {
  if (typeof options.token !== "string" || options.token.length === 0) {
    throw new Error("LOCAL_EXEC_SHARED_SECRET must be set");
  }
  const backendOptions: LocalSpawnBackendOptions = {
    mappings: options.mappings,
    defaultTimeoutMs: options.defaultTimeoutMs,
    maxStdoutBytes: options.maxStdoutBytes,
    maxStderrBytes: options.maxStderrBytes,
  };
  const backend = new LocalSpawnBackend(backendOptions);
  const server = new ExecutionHttpServer({
    backend,
    token: options.token,
    profile: "host",
    capabilities: await backend.getCapabilities(),
    defaults: {
      timeoutMs: options.defaultTimeoutMs ?? 120_000,
      maxStdoutBytes: options.maxStdoutBytes ?? 4 * 1024 * 1024,
      maxStderrBytes: options.maxStderrBytes ?? 4 * 1024 * 1024,
    },
  });
  const port = await server.listen(options.port ?? 8787, options.host ?? "127.0.0.1");
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}
