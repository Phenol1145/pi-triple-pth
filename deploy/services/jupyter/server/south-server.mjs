/**
 * jupyter 南面 execution/v1.1 服务（P5，2026-08-22）。
 *
 * engine 是唯一客户端：jupyter-runtime-adapter 经 backend registry（id=jupyter）
 * 把 probe（jupyter-notebook --version / python import 栈）与 clean-kernel
 * execute-all（python3 driver.py ...）作为 sync 命令发给本服务。
 * 北面 JupyterLab（8888）由同一容器 entrypoint 启动；浏览器不接触本端口。
 */

import {
  EXECUTION_PROTOCOL_VERSION_V11,
  ExecutionHttpServer,
  LocalBackend,
} from "@away_from/shared/execution";

const port = Number.parseInt(process.env.JUPYTER_SOUTH_PORT ?? "8889", 10);
const token = process.env.JUPYTER_SERVICE_TOKEN;
if (!token) {
  console.error("FATAL: JUPYTER_SERVICE_TOKEN not set");
  process.exit(1);
}

const backend = new LocalBackend({
  defaultTimeoutMs: 600_000,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 4 * 1024 * 1024,
});

const server = new ExecutionHttpServer({
  backend,
  token: () => process.env.JUPYTER_SERVICE_TOKEN,
  profile: "host",
  capabilities: {
    version: EXECUTION_PROTOCOL_VERSION_V11,
    streaming: false,
    cancel: false,
    cwdWhitelist: false,
    uidIsolation: false,
    egressLocked: false,
    pathMapping: false,
    modes: { sync: true, stream: false, interactive: false, persistent: false },
  },
  defaults: { timeoutMs: 600_000, maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 4 * 1024 * 1024 },
  maxBodyBytes: 6 * 1024 * 1024,
});

await server.listen(port, "0.0.0.0");
console.log(`jupyter south execution/v1.1 listening on :${port}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
