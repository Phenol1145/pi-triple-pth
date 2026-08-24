/**
 * bootstrap/batch/host-bootstrap.ts —— P2-9 装配段：Host 引导 + sandbox 接线 + PG 池。
 *
 * buildPthHost（fork worker 前 fail-closed：非法 descriptor / route typo / strict+required
 * 探测失败）→ 执行后端探测 → sandbox descriptor/url 接线 → PG 连接池 + schema。
 */

import { createPgPool, applySchema } from "@away_from/pth-kernel-storage";
import { createKernelLogger } from "@away_from/pth-kernel-execution";
import { pthConfig } from "@away_from/pth-config";
import type { BuiltPthHost } from "../pth-host.js";
import type { BatchLogger, BatchPool } from "./context.js";

export interface BatchHostBootstrap {
  host: BuiltPthHost;
  batchLogger: BatchLogger;
  sandboxKernelUrl: string;
  sandboxKernelSecret: string;
  pool: BatchPool;
}

export async function bootstrapBatchHost(input: { databaseUrl: string }): Promise<BatchHostBootstrap> {
  // P1：runner Host 与 API Host 共用同一 bootstrap manifest + 执行后端注册表
  // （fork worker 前 fail-closed：非法 descriptor / route typo / strict+required 探测失败）。
  const { loadBootstrapConfig } = await import("../bootstrap-config.js");
  const { buildPthHost, isStrictExecutionEnv } = await import("../pth-host.js");
  const { probeExecutionBackends } = await import("../../execution/index.js");
  const host = await buildPthHost(loadBootstrapConfig().manifest);
  const startupLogger = createKernelLogger({
    ipcSend: (msg) => { try { process.send?.(msg); } catch { /* IPC 不可用 */ } },
  });
  const batchLogger = startupLogger.child("batch", { pid: process.pid });
  for (const warning of host.executionWarnings) {
    batchLogger.warn(warning);
  }
  await probeExecutionBackends(host.backends, {
    strict: isStrictExecutionEnv(),
    timeoutMs: pthConfig().num("PTH_EXEC_BACKEND_PROBE_TIMEOUT_MS"),
    logger: {
      warn: (message) => batchLogger.warn(message),
      error: (message) => batchLogger.error(message),
    },
  });
  // kernel sandbox 接线：sandbox descriptor 优先（url/token），旧 env 兜底。
  const sandboxBackend = host.backends.get("sandbox");
  const sandboxKernelUrl = sandboxBackend?.descriptor.url ?? pthConfig().str("PTH_SANDBOX_KERNEL_URL");
  const sandboxKernelSecret = sandboxBackend?.descriptor.tokenEnv !== undefined
    ? (process.env[sandboxBackend.descriptor.tokenEnv] ?? "")
    : pthConfig().str("SANDBOX_SHARED_SECRET");
  // 内存优化：连接池收紧（7 角色 worker 并发 ≤7——max 8 够；默认 10 冗余）
  // PTH_PG_POOL_MAX 可覆盖（batch 数多时 PG 连接总量 = pool_max × batches 需核算）
  const pool = await createPgPool({ connectionString: input.databaseUrl, max: pthConfig().num("PTH_PG_POOL_MAX") });
  await applySchema(pool);
  return { host, batchLogger, sandboxKernelUrl, sandboxKernelSecret, pool };
}
