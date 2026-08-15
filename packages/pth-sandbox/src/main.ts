/**
 * sandbox 服务入口（F/WP3 Task 10）
 *
 * 容器内运行（Dockerfile.sandbox，非 root USER node）；egress 锁定由 compose
 * internal 网络保证；共享密钥经 SANDBOX_SHARED_SECRET env 注入（不镜像硬编码）。
 */

import { buildExecApp } from "./exec-api.js";
import { registerKernelHost } from "./kernel-host.js";

const port = parseInt(process.env.PORT ?? "8080", 10);
const app = buildExecApp();
// kernel sandbox SPEC：kernel 宿主与 exec API 同端口（internal 网络内 PTH 可达）
registerKernelHost(app, {});

try {
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`sandbox exec-api listening on :${port}`);
} catch (err) {
  console.error("Fatal:", err);
  process.exit(1);
}

process.on("SIGTERM", async () => {
  await app.close();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await app.close();
  process.exit(0);
});
