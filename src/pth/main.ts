import { Redis } from "ioredis";
import { detectPlatform, createLogger } from "@away_from/infra";
import { createMetrics, startRedisMetrics } from "./observability/metrics.js";
import { createKernelMetrics } from "./observability/kernel-metrics.js";
import { AuditWriter } from "./observability/audit.js";
import { RedisSessionStore } from "./kernel/storage/session/redis-session-store.js";
import { EnvCredentialProvider, WorkspaceManager, ModelRouter } from "@away_from/infra";
import { ToolRegistry } from "./tools/registry.js";
import { ToolPlatform } from "./tools/platform.js";
import { SandboxExecClient, SandboxHealthMonitor, createSandboxBashDefinition } from "@away_from/pth-sandbox";
import { createSandboxDebugGatewayFactory } from "./gateway/routes-debug.js";
import { SessionPool } from "./core/session-pool.js";
import { AgentEngine } from "./core/agent-engine.js";
import { WorkflowOrchestrator } from "./workflow/orchestrator.js";
import { createIntentWorker } from "./workflow/bullmq-worker.js";
import { HotReloader, ResourceOverlay } from "./self-modify/hot-reloader.js";
import { FallbackRequestStore } from "./fallback/requests.js";
import { createServer } from "./gateway/server.js";
import { createKernelRuntime } from "./kernel/assembly.js";
import "./impls/kernels/index.js"; // 模块化优化 P0：具体核工厂注入 kernel 端口（setKernelExecFactory）
import { createExecutionGrantService } from "./execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "./execution/authorization/grant-key-provider.js";
import { createPthKnowledgeBroker } from "./execution/adapters/pth-knowledge-broker.js";
import { loadBootstrapConfig } from "./bootstrap/bootstrap-config.js";
import { buildPthHost } from "./bootstrap/pth-host.js";
import { pthConfig, validatePthConfig } from "./config/index.js";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const platform = detectPlatform();
  const logger = createLogger(pthConfig().str("LOG_LEVEL"));

  // 配置集中化 C3：启动校验（PTH_CONFIG_STRICT=1 / NODE_ENV=production 时弱密钥与开发默认值 fail-fast）
  const configIssues = validatePthConfig();
  for (const issue of configIssues) {
    if (issue.level === "error") logger.error({ key: issue.key, message: issue.message, event: "config_validation_failed" });
    else logger.warn({ key: issue.key, message: issue.message, event: "config_validation_warn" });
  }
  if (configIssues.some((i) => i.level === "error")) {
    logger.error({ event: "config_validation_abort", note: "PTH_CONFIG_STRICT 模式拒绝启动（配置不安全）" });
    process.exit(1);
  }

  logger.info({ os: platform.os, arch: platform.arch, event: "platform_starting" });

/** 凭据注入 pi-ai env（DEEPSEEK_API_KEY 等——原生 tool_calls 需要——auth.json 单一源） */
async function injectPiAiKeysFromAuth(): Promise<void> {
  const { resolveSdkConfigPaths } = await import("@away_from/infra");
  const authPath = resolveSdkConfigPaths().authPath;
  if (!authPath) return;
  // provider → pi-ai env 变量（env-api-keys 映射——deepseek 等）
  const envMap: Record<string, string> = { deepseek: "DEEPSEEK_API_KEY", kimi: "KIMI_API_KEY", zai: "ZAI_API_KEY" };
  try {
    const { readFile } = await import("node:fs/promises");
    const auth = JSON.parse(await readFile(authPath, "utf8")) as Record<string, { key?: string }>;
    for (const [provider, cfg] of Object.entries(auth)) {
      const envVar = envMap[provider];
      const key = cfg?.key;
      if (envVar && key && !process.env[envVar]) process.env[envVar] = key;
    }
  } catch { /* auth 不可读——env 兜底 */ }
}

  const redisUrl = pthConfig().str("REDIS_URL");
  const redis = new Redis(redisUrl);

  const metrics = createMetrics();
  startRedisMetrics(redis, metrics);
  // 性能计量（SPEC L0/L1）：kernel 指标注册到同一 registry（/metrics 单端点聚合）
  const kernelMetrics = createKernelMetrics({ registry: metrics.registry });

  const sessionStore = new RedisSessionStore(redis);
  // 设置面：RedisSettingsStore 已删（2026-08-14 A2 Phase 2——创建零消费的死接线；
  //   SettingsStore 协议保留在 kernel/storage/session/interfaces.ts——tenant settings 需求按契约重建）
  const credentials = new EnvCredentialProvider();
  const audit = new AuditWriter(redis);

  const dataDir = pthConfig().str("DATA_DIR");
  const workspaceMgr = new WorkspaceManager(
    platform,
    `${dataDir}/workspaces`,
    `${dataDir}/platform`,
    `${dataDir}/tenants`,
  );

  // 原生工具调用（agent 循环——OpenAI tool_calls）：pi-ai 从 env 读 provider key
  // （DEEPSEEK_API_KEY 等——env-api-keys 映射）——从 auth.json 注入（单一源——SDK 路径同源）
  await injectPiAiKeysFromAuth();
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
  const sandboxClient = new SandboxExecClient({
    baseUrl: process.env.SANDBOX_URL ?? "http://localhost:8080",
    secret: process.env.SANDBOX_SHARED_SECRET ?? "",
    monitor: sandboxMonitor,
  });
  const sandboxBash = createSandboxBashDefinition(sandboxClient);
  // F/WP4 Task 22：hub debug 调试网关——WebSocket → sandbox 行式执行通道（同一 sandbox 容器）
  const debugGateway = createSandboxDebugGatewayFactory(sandboxClient);
  // S3 路径 b：agent-lab 经 extensionFactories 编程注入常驻系统会话（F/WP5 Task 24）。
  // 非字面量 import specifier——tsc rootDir=src 不能静态 import extensions/ 下的 .ts（TS5097）；
  // 运行时同一相对路径在 dev（tsx src/）与 prod（node dist/）都解析到 <pkgroot>/extensions/agent-lab/index.ts
  // （Node>=22.18 type-stripping 默认开启，可加载 .ts）。失败放行（fail-open）：无 agent-lab 仍可运行。
  const agentLabSpecifier = "../../extensions/agent-lab/index.ts";
  const systemExtensionFactories: any[] = [];
  try {
    const agentLabModule: any = await import(agentLabSpecifier);
    if (agentLabModule?.default) systemExtensionFactories.push(agentLabModule.default);
    logger.info({ event: "agent_lab_loaded", note: "agent-lab 扩展已注入常驻系统会话（extensionFactories）" });
  } catch (err) {
    logger.warn({ err: String(err), event: "agent_lab_load_failed", note: "agent-lab 未注入常驻会话——失败放行" });
  }
  const engine = new AgentEngine(pool, modelRouter, workspaceMgr, sessionStore, toolPlatform, logger, metrics, path.join(dataDir, "sessions"), audit, resourceOverlay, sandboxBash, systemExtensionFactories);
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

  // F/WP5 Task 23：启动时创建常驻系统会话（RESERVED——evict 豁免/优先恢复/watchdog 重建）
  // 轻量状态化（二轮评审 Important 3）：常驻会话不持大状态，watchdog 缺席即重建。
  const sysRes = await engine.createSystemSession();
  if (!sysRes.ok) {
    logger.warn({ err: sysRes.error, event: "system_session_start_failed", note: "常驻会话启动失败——watchdog 仍会重试" });
  } else {
    logger.info({ sessionId: sysRes.data.sessionId, event: "system_session_ready" });
  }
  engine.startSystemWatchdog();

  // Program store（ptl submit 提交物）/ ComponentStore 泛化（F/WP4 Task 17）：
  // components 卷落在 DATA_DIR/components/<tenantId>/<type>/<name>/<version>/；
  // 旧 programs 目录（DATA_DIR/programs/programs/...）不做自动迁移，ProgramStore 读侧双查兼容（plan N4）。
  const { ProgramStore } = await import("./programs/store.js");
  const programStore = new ProgramStore(redis, dataDir, audit);
  // F/WP4 Task 20：fallback_requests 回退请求队列（手动建单先行；自动触发留 E）
  const fallbackStore = new FallbackRequestStore(redis, audit);
  logger.warn({
    event: "component_store_v1_switch",
    detail: "components 卷已生效（DATA_DIR/components）；legacy programs 目录仅读侧兼容，不做自动迁移",
  });

  const port = parseInt(process.env.PORT ?? "3000", 10);

  // ── PTH kernel 装配（装配层 Task 2 + 接线 Task 1）──
  // DATABASE_URL 注入（compose 已配 postgres）→ createKernelRuntime（pg + dataWorld + BatchManager + watchdog）。
  // fail-open：pg 不可达时 kernelRuntime = null，/kernel/* 路由 503，PTH 其余功能照常。
  const databaseUrl = process.env.DATABASE_URL;

  // P3-4：单 Host bootstrap——manifest 校验与 catalog 构建在监听端口前 fail-closed
  try {
    await buildPthHost(loadBootstrapConfig().manifest);
  } catch (err) {
    logger.error({ err: String(err), event: "bootstrap_failed", note: "manifest 非法/依赖缺失——拒绝启动" });
    process.exit(1);
  }
  let kernelRuntime: Awaited<ReturnType<typeof createKernelRuntime>> | null = null;
  // 性能自持（v0.8）：PerfAutopilot 自愈闭环——创建于 kernel 装配后（registry + batchManager 就绪）
  let autopilot: import("./kernel/execution/perf-autopilot.js").PerfAutopilot | null = null;
  if (databaseUrl) {
    try {
      kernelRuntime = await createKernelRuntime({
        databaseUrl,
        basePath: path.join(dataDir, "workspaces"),
        artifactPath: path.join(dataDir, "artifacts"),
        toolstorePath: path.join(dataDir, "toolstore"),
        // 性能计量（SPEC L1）：batch IPC metric → kernelMetrics
        onMetric: (m) => {
          const t = m as Record<string, unknown>;
          if (t.kind === "llm") {
            kernelMetrics.llmCall(
              String(t.provider ?? "?"), String(t.model ?? "?"),
              Number(t.durationMs ?? 0), Number(t.inputTokens ?? 0), Number(t.outputTokens ?? 0),
            );
          } else if (t.type === "exec") {
            kernelMetrics.kernelExec(String(t.language ?? "?"), Number(t.durationMs ?? 0), Boolean(t.ok));
          } else if (t.type === "truncated") {
            kernelMetrics.kernelTruncated(String(t.language ?? "?"), String(t.field ?? "?"));
          } else if (t.domain === "task") {
            if (t.type === "status") kernelMetrics.taskStatus(String(t.status ?? "?"));
            else if (t.type === "stage") kernelMetrics.taskStage(String(t.stage ?? "?"), Number(t.durationMs ?? 0));
            else if (t.type === "reject-reason") kernelMetrics.taskRejectedReason(String(t.reason ?? "other"));
            else if (t.type === "exec") kernelMetrics.kernelExec(String(t.language ?? "?"), Number(t.durationMs ?? 0), Boolean(t.ok));
          } else if (t.domain === "refine") {
            if (t.type === "refine-duration") kernelMetrics.refineDuration(Number(t.durationMs ?? 0));
            else if (t.type === "refine-yield") kernelMetrics.refineYield(String(t.kind ?? "?"), Number(t.count ?? 0));
            else if (t.type === "refine-degraded") kernelMetrics.refineDegraded(String(t.reason ?? "?"));
          }
        },
        // obs 观测请求（batch → 主进程）：metrics（prom registry）/ batches（BatchManager 状态）
        obsResolver: async (req, params) => {
          if (req === "metrics") {
            const pattern = String((params as Record<string, unknown> | undefined)?.["pattern"] ?? "");
            try {
              const all = await metrics.registry.getMetricsAsJSON();
              const list = pattern
                ? all.filter((m: { name: string }) => m.name.includes(pattern))
                : all;
              return list.map((m: { name: string; values: unknown[] }) => ({ name: m.name, values: m.values }));
            } catch (e) {
              return { error: (e as Error).message };
            }
          }
          if (req === "batches") {
            if (!kernelRuntime?.batchManager) return { error: "kernel 未装配" };
            const bs = await kernelRuntime.batchManager.listBatches();
            return bs.map((b: any) => ({
              id: b.id,
              pid: b.pid ?? b.child?.pid,
              workers: b.workers,
              // BatchStatus.currentTasks 是 Record（workerId → taskId）——Object.values 遍历
              tasks: b.currentTasks && typeof b.currentTasks === "object" ? Object.values(b.currentTasks) : [],
              idleRatio: b.idleRatio,
              // 2026-08-18 L3：健康面透传（sensor:system-opt 数据源——§9 L2）
              health: b.health,
              heartbeatLagMs: b.heartbeatLagMs,
              rssBytes: b.rssBytes,
              cpuUserUs: b.cpuUserUs,
              cpuSystemUs: b.cpuSystemUs,
            }));
          }
          return { error: `未知 obs 请求: ${req}` };
        },
        // 生产 fork：dist 编译产物（纯 js，无需 loader/transform-types）；watchdog 30s 探测
      });
      logger.info({ event: "kernel_assembled", note: "PTH kernel 装配成功（pg + dataWorld + BatchManager + watchdog）" });

      // 性能自持（v0.8）：PerfAutopilot 自愈闭环——PTH_AUTOPILOT_MODE=on 启用
      if (pthConfig().str("PTH_AUTOPILOT_MODE") === "on" && kernelRuntime) {
        const rt = kernelRuntime;  // 非空收紧
        const { PerfAutopilot } = await import("./kernel/execution/perf-autopilot.js");
        const batchManager = kernelRuntime.batchManager;
        const autopilotIntervalMs = pthConfig().num("PTH_AUTOPILOT_INTERVAL_MS");
        autopilot = new PerfAutopilot(
          {
            registry: metrics.registry,
            setParam: (key, value) => {
              // 下发到全部活跃 batch（batch 子进程 perf config）
              void (async () => {
                const batches = await batchManager.listBatches();
                for (const b of batches) {
                  if (batchManager.isBatchAlive(b.id)) void batchManager.setParam(b.id, key, value);
                }
              })();
            },
            getParam: (key) => process.env[key],
            countPendingByRole: async () => rt.dataWorld.tasks.countPendingByRole(),
            spawnReinforced: async (role, copies) => {
              return batchManager.spawnBatch({ mode: "reinforced", role, copies });
            },
            log: (level, msg, meta) => logger[level]({ ...(meta ?? {}), event: "autopilot", msg }),
          },
          {
            mode: "on",
            intervalMs: autopilotIntervalMs,
            windowMs: pthConfig().num("PTH_AUTOPILOT_WINDOW_MS"),
            rejectRate: pthConfig().num("PTH_AUTOPILOT_REJECT_RATE"),
            execFailRate: pthConfig().num("PTH_AUTOPILOT_EXEC_FAIL_RATE"),
            llmSlowMs: pthConfig().num("PTH_AUTOPILOT_LLM_SLOW_MS"),
            pendingGrowth: pthConfig().num("PTH_AUTOPILOT_PENDING_GROWTH"),
            maxCopies: pthConfig().num("PTH_AUTOPILOT_MAX_COPIES"),
          },
        );
        // trigger 统一化（2026-08-16）：autopilot 不自起定时器——perf-autopilot schedule trigger 驱动 tick
        rt.triggerEngine.registerAction("perf-autopilot.tick", async () => {
          await autopilot?.tick();
        });
        rt.triggerEngine.addSystemTrigger({
          name: "perf-autopilot",
          schedule: { everySec: autopilotIntervalMs / 1000 },
          action: { type: "perf-autopilot.tick" },
          enabled: true,
        });
      }
    } catch (err) {
      logger.warn({ err: String(err), event: "kernel_assembly_failed", note: "kernel 装配失败——/kernel/* 路由 503，PTH 其余功能照常" });
    }
  } else {
    logger.warn({ event: "kernel_disabled", note: "未设置 DATABASE_URL——kernel 未装配" });
  }

  // P2-5：grant-bound 知识 broker（PTH_EXECUTION_GRANT_SECRET 与 sandbox 共用同一签名密钥；
  // 未配置 → /kernel/knowledge 503 fail-closed，token 化 memory-bridge 兼容通道不受影响）
  const executionGrantSecret = pthConfig().str("PTH_EXECUTION_GRANT_SECRET");
  const knowledgeBroker = kernelRuntime && executionGrantSecret
    ? createPthKnowledgeBroker({
        grantService: createExecutionGrantService({ keyProvider: createHmacGrantKeyProvider({ secret: executionGrantSecret }) }),
        dataWorld: kernelRuntime.dataWorld,
      })
    : null;

  // N33 Task 5：intake 手动控制面（operator console 的订阅创建/run 触发窄端点）。
  // 需要 kernel（pg pool）+ 已验签 TrustPolicy（PTH_TRUST_POLICY_MANIFEST/KEYRING）；
  // 任一缺席 → /api/v1/intake/* 503，PTH 其余功能照常（与 kernel fail-open 约定一致）。
  // 已验签 policy 启动时加载一次（manifest 是不可变签名事实——轮换需重启）。
  let intakeManualControl: import("./execution/knowledge-intake/manual-control.js").IntakeManualControlService | null = null;
  const intakeManifestPath = pthConfig().str("PTH_TRUST_POLICY_MANIFEST");
  const intakeKeyringPath = pthConfig().str("PTH_TRUST_POLICY_KEYRING");
  if (kernelRuntime && intakeManifestPath && intakeKeyringPath) {
    try {
      const { loadVerifiedTrustPolicy } = await import("./execution/knowledge-intake/trust-policy.js");
      const { createKnowledgeIntakeRepository } = await import("./kernel/storage/knowledge-intake-pg.js");
      const { createIntakeManualControlService } = await import("./execution/knowledge-intake/manual-control.js");
      const manifest = JSON.parse(await fs.promises.readFile(intakeManifestPath, "utf8")) as Parameters<typeof loadVerifiedTrustPolicy>[0];
      const keyring = JSON.parse(await fs.promises.readFile(intakeKeyringPath, "utf8")) as Parameters<typeof loadVerifiedTrustPolicy>[1];
      const verifiedPolicy = await loadVerifiedTrustPolicy(manifest, keyring);
      const intakeRepository = createKnowledgeIntakeRepository(kernelRuntime.pool, {
        policyVerifier: (candidate) => loadVerifiedTrustPolicy(candidate, keyring),
      });
      intakeManualControl = createIntakeManualControlService({
        pool: kernelRuntime.pool,
        repository: intakeRepository,
        policy: verifiedPolicy,
      });
      logger.info({
        event: "intake_manual_control_ready",
        note: `intake 手动控制面已装配（policy=${verifiedPolicy.manifest.policyId}@${verifiedPolicy.manifest.version}）`,
      });
    } catch (err) {
      logger.warn({ err: String(err), event: "intake_manual_control_disabled", note: "intake 手动控制面装配失败——/intake/* 503，PTH 其余功能照常" });
    }
  }

  // N33 Task 3：/api/v1/observe/{workers,memory/*,config,roles} 由 server.ts 内
  // registerSystemInspectionRoutes 注册（facade 从 kernelRuntime.pool/batchManager 装配）。
  const server = await createServer({ redis, engine, toolPlatform, metrics, logger, port, programs: programStore, fallback: fallbackStore, sandboxMonitor, sessionStore, debugGateway, audit, kernelRuntime, knowledgeBroker, intakeManualControl });
  await server.listen({ port, host: "0.0.0.0" });
  logger.info({ port, event: "server_listening" });

  const shutdown = async (signal: string) => {
    logger.info({ signal, event: "shutdown_start" });
    kernelMetrics.dispose();
    autopilot?.stop();
    if (kernelRuntime) await kernelRuntime.shutdown();
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
