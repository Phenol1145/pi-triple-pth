import { Redis } from "ioredis";
import { detectPlatform } from "../shared/platform/index.js";
import { createLogger } from "../shared/observability/logger.js";
import { createMetrics, startRedisMetrics } from "./observability/metrics.js";
import { AuditWriter } from "./observability/audit.js";
import { RedisSessionStore } from "./storage/redis-session-store.js";
import { RedisSettingsStore } from "./storage/redis-settings-store.js";
import { EnvCredentialProvider } from "../shared/credential-provider.js";
import { WorkspaceManager } from "../shared/workspace/manager.js";
import { ModelRouter } from "../shared/model-router/router.js";
import { ToolRegistry } from "./tools/registry.js";
import { ToolPlatform } from "./tools/platform.js";
import { SandboxExecClient, SandboxHealthMonitor, createSandboxBashDefinition } from "./tools/sandbox-bash.js";
import { SessionPool } from "./core/session-pool.js";
import { AgentEngine } from "./core/agent-engine.js";
import { WorkflowOrchestrator } from "./workflow/orchestrator.js";
import { createIntentWorker } from "./workflow/bullmq-worker.js";
import { HotReloader, ResourceOverlay } from "./self-modify/hot-reloader.js";
import { createServer } from "./gateway/server.js";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const platform = detectPlatform();
  const logger = createLogger(process.env.LOG_LEVEL ?? "info");

  logger.info({ os: platform.os, arch: platform.arch, event: "platform_starting" });

  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const redis = new Redis(redisUrl);

  const metrics = createMetrics();
  startRedisMetrics(redis, metrics);

  const sessionStore = new RedisSessionStore(redis);
  const settingsStore = new RedisSettingsStore(redis);
  const credentials = new EnvCredentialProvider();
  const audit = new AuditWriter(redis);

  const dataDir = process.env.DATA_DIR ?? "./.pi-platform-data";
  const workspaceMgr = new WorkspaceManager(
    platform,
    `${dataDir}/workspaces`,
    `${dataDir}/platform`,
    `${dataDir}/tenants`,
  );

  const modelRouter = new ModelRouter(credentials, logger);
  await modelRouter.initialize();

  const toolRegistry = new ToolRegistry();
  const toolPlatform = new ToolPlatform(toolRegistry, audit, metrics, logger);

  const pool = new SessionPool(
    { maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 },
    sessionStore, logger, metrics, redis,
  );
  // L1 热更覆盖层（F/WP2 Task 8）：HotReloader 校验通过 → 覆盖层推进，AgentEngine
  // 为后续会话的 ResourceLoader 注入（agent-dir 卷为基准，platform 卷为覆盖层）
  const resourceOverlay = new ResourceOverlay();
  // F/WP3 Task 11：bash 工具全量转发 sandbox（统一接口名 bash，平台级替换内建）。
  // 共享密钥 env 注入（SANDBOX_SHARED_SECRET）；本地开发未设 env 时默认 localhost:8080 + 空密钥（fail-closed）。
  // F/WP3 Task 13：失效降级监控——连续 SANDBOX_DEGRADED_THRESHOLD 次转发失败 → degraded；
  // 定期探活 /health 恢复 → 自动清除。进入/退出写审计事件（tenantId=system 系统级）。
  const sandboxThreshold = Math.max(1, parseInt(process.env.SANDBOX_DEGRADED_THRESHOLD ?? "3", 10) || 3);
  const sandboxMonitor = new SandboxHealthMonitor({
    failureThreshold: sandboxThreshold,
    baseUrl: process.env.SANDBOX_URL ?? "http://localhost:8080",
    onStateChange: (degraded, consecutiveFailures) => {
      if (degraded) {
        audit.write({
          tenantId: "system", actor: "system", action: "sandbox_degraded_enter",
          details: { consecutiveFailures, threshold: sandboxThreshold },
        });
        logger.warn({ consecutiveFailures, threshold: sandboxThreshold, event: "sandbox_degraded" });
      } else {
        audit.write({
          tenantId: "system", actor: "system", action: "sandbox_degraded_exit",
          details: { consecutiveFailures },
        });
        logger.info({ event: "sandbox_degraded_recovered" });
      }
    },
  });
  const sandboxBash = createSandboxBashDefinition(new SandboxExecClient({
    baseUrl: process.env.SANDBOX_URL ?? "http://localhost:8080",
    secret: process.env.SANDBOX_SHARED_SECRET ?? "",
    monitor: sandboxMonitor,
  }));
  const engine = new AgentEngine(pool, modelRouter, workspaceMgr, sessionStore, toolPlatform, logger, metrics, path.join(dataDir, "sessions"), audit, resourceOverlay, sandboxBash);
  pool.setOnEvict((sid) => engine.evictSession(sid));
  const orchestrator = new WorkflowOrchestrator(redis, engine, sessionStore, logger, metrics);

  const platformDir = workspaceMgr.getPlatformDir();
  if (fs.existsSync(platformDir)) {
    const hotReloader = new HotReloader(platformDir, logger, metrics, (result) => {
      logger.info({ loaded: result.loaded, errors: result.errors, event: "hot_reload" });
    }, resourceOverlay);
    hotReloader.start();
  }

  // BullMQ intent worker (processes intents from workflow)
  createIntentWorker(redisUrl, async (intent) => {
    logger.info({ intent, event: "intent_received" });
  });

  await engine.recoverAll();

  // Program store（pit submit 提交物）/ ComponentStore 泛化（F/WP4 Task 17）：
  // components 卷落在 DATA_DIR/components/<tenantId>/<type>/<name>/<version>/；
  // 旧 programs 目录（DATA_DIR/programs/programs/...）不做自动迁移，ProgramStore 读侧双查兼容（plan N4）。
  const { ProgramStore } = await import("./programs/store.js");
  const programStore = new ProgramStore(redis, dataDir, audit);
  logger.warn({
    event: "component_store_v1_switch",
    detail: "components 卷已生效（DATA_DIR/components）；legacy programs 目录仅读侧兼容，不做自动迁移",
  });

  const port = parseInt(process.env.PORT ?? "3000", 10);
  const server = await createServer({ redis, engine, toolPlatform, metrics, logger, port, programs: programStore, sandboxMonitor });
  await server.listen({ port, host: "0.0.0.0" });
  logger.info({ port, event: "server_listening" });

  const shutdown = async (signal: string) => {
    logger.info({ signal, event: "shutdown_start" });
    await engine.drain();
    await server.close();
    await redis.quit();
    process.exit(0);
  };

  process.on(platform.process.signal.graceful, () => shutdown(platform.process.signal.graceful));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
