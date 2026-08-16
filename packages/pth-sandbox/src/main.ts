/**
 * sandbox 服务入口（F/WP3 Task 10）
 *
 * 容器内运行（Dockerfile.sandbox，非 root USER node）；egress 锁定由 compose
 * internal 网络保证；共享密钥经 SANDBOX_SHARED_SECRET env 注入（不镜像硬编码）。
 */

import { buildExecApp } from "./exec-api.js";
import { registerKernelHost } from "./kernel-host.js";
import { createSandboxGrantVerifier } from "./authorization/grant-verifier.js";

const port = parseInt(process.env.PORT ?? "8080", 10);
// P2-2：/kernel/acquire 只接受签名 grant；密钥 bootstrap 注入（PTH_EXECUTION_GRANT_SECRET），无默认值。
import { loadSandboxConfig } from "./config.js";
const grantSecret = loadSandboxConfig().executionGrantSecret;
const app = buildExecApp({
  // P2-6：readiness 聚合 kernel grant verifier 装配状态
  readinessChecks: [{ name: "execution-grant-verifier", check: () => Boolean(grantSecret) }],
});
// kernel sandbox SPEC：kernel 宿主与 exec API 同端口（internal 网络内 PTH 可达）
registerKernelHost(app, grantSecret ? { grantVerifier: createSandboxGrantVerifier({ secret: grantSecret }) } : {});

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
