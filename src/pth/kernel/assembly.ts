import { createPgPool, applySchema, createDataWorld } from "./storage/index.js";
import { BatchManager } from "./execution/batch-manager.js";
import { DEFAULT_ROLES, parseRoleWeights, expandRoleWeights } from "./execution/worker-cluster.js";
import { TaskResolver } from "./execution/task-resolver.js";
import { evaluateAndScale, loadScalerConfig } from "./execution/batch-scaler.js";
import { createKernelLogger } from "./logger.js";
import type pg from "pg";

export interface KernelRuntimeOptions {
  /** obs 观测请求解析器（batch obs-req → 主进程 metrics/batches 数据） */
  obsResolver?: (req: string, params: unknown) => Promise<unknown>;
  databaseUrl: string;
  basePath: string;       // 工作区根（workspaces）
  artifactPath: string;   // 产物归档根（artifacts）
  batchProcessPath?: string;  // batch-process 入口（默认按运行环境解析：dist 优先，src 兜底）
  execArgv?: string[];    // 生产 fork 透传（TS 源码模式：transform-types + resolve-hook loader）
  env?: Record<string, string>;  // 生产 fork 环境透传（PTH_BATCH_PROCESS/DATABASE_URL 等）
  toolstorePath?: string;  // toolstore 文件通道目录（默认继承主进程 env）
  watchdogIntervalMs?: number; // watchdog 探测周期（默认 30s）
  resolverIntervalMs?: number; // TaskResolver 解析轮询周期（默认 2s）
  /** 性能计量（SPEC L1）：batch kernel/llm 事件回调（main.ts 接 kernelMetrics） */
  onMetric?: (m: Record<string, unknown>) => void;
}

export interface KernelWatchdogEvent {
  batchId: string;
  pid: number;
  ts: number;
}

/**
 * PTH kernel watchdog（装配层 Task 2）：
 * 周期探测 BatchManager 中 batch 子进程存活；崩溃（exit 且未 kill）→ 记录事件。
 * v1 约束：只记录不自动重启（plan Task 2「watchdog（batch 崩溃记录，不自动重启 v1）」）。
 */
export class KernelWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private crashLog: KernelWatchdogEvent[] = [];

  constructor(
    private batchManager: BatchManager,
    private logger: (msg: string) => void = () => {},
  ) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.probe(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 探测一轮：遍历 BatchManager 存活 batch，崩溃则记录。返回本轮新增崩溃事件数。 */
  async probe(): Promise<number> {
    let crashes = 0;
    for (const status of await this.batchManager.listBatches()) {
      if (this.batchManager.isBatchAlive(status.id)) continue;
      const evt: KernelWatchdogEvent = { batchId: status.id, pid: status.pid, ts: Date.now() };
      this.crashLog.push(evt);
      this.logger(`[watchdog] batch ${status.id} crashed (pid ${status.pid}) — recorded, no auto-restart (v1)`);
      crashes++;
    }
    return crashes;
  }

  getCrashLog(): KernelWatchdogEvent[] {
    return [...this.crashLog];
  }
}

export interface KernelRuntime {
  pool: pg.Pool;
  dataWorld: ReturnType<typeof createDataWorld>;
  batchManager: BatchManager;
  watchdog: KernelWatchdog;
  /** TaskResolver（任务池即工作流 T3）：独立解析循环 */
  resolver: import("./execution/task-resolver.js").TaskResolver;
  shutdown: () => Promise<void>;
}

/**
 * PTH kernel 统一装配（装配层 Task 2）：
 * pg 连接池 → applySchema → dataWorld（tasks/memory/transcripts/audit）
 * → BatchManager（fork batch-process 子进程）+ watchdog（崩溃记录，不自动重启 v1）。
 */
/**
 * 按运行环境解析 batch-process 入口：PTH_BATCH_TS=1（dev 源码模式——tsx watch 热更新）
 * → src TS；否则（生产）→ dist 编译产物。execArgv 配套（PTH_BATCH_TS 时 tsx loader）。
 */
function resolveBatchProcessPath(explicit: string | undefined): string {
  if (explicit) return explicit;
  if (process.env.PTH_BATCH_TS === "1") return "src/pth/kernel/execution/batch-process.ts";
  return "dist/pth/kernel/execution/batch-process.js";
}

export async function createKernelRuntime(opts: KernelRuntimeOptions): Promise<KernelRuntime> {
  const pool = await createPgPool({ connectionString: opts.databaseUrl });
  await applySchema(pool);

  const dataWorld = createDataWorld(pool);
  const assemblyLogger = createKernelLogger();
  const batchManager = new BatchManager({
    batchProcessPath: resolveBatchProcessPath(opts.batchProcessPath),
    // batch 构成参数化：PTH_WORKER_ROLES 展开（副本重复）——与子进程自身解析一致
    workers: expandRoleWeights(parseRoleWeights(opts.env?.PTH_WORKER_ROLES ?? process.env.PTH_WORKER_ROLES)).map((r) => r.id),
    // dev 源码模式（PTH_BATCH_TS=1——batch-process.ts）→ fork 用 tsx loader（execArgv 未显式时默认注入）
    execArgv: opts.execArgv ?? (process.env.PTH_BATCH_TS === "1" ? ["--import", "tsx"] : undefined),
    logger: createKernelLogger(),
    onMetric: opts.onMetric,
    obsResolver: opts.obsResolver,
    // 自动注入 kernel 子进程 env（试运行发现：main.ts 只传 databaseUrl 不传 env，
    // fork 的子进程没有 PTH_BATCH_PROCESS/DATABASE_URL → 不进入 batch 入口 → 立即退出）。
    // 调用方显式传 env 时覆盖（后进覆盖先进）。
    env: {
      PTH_BATCH_PROCESS: "1",
      PTH_TEST_DATABASE_URL: opts.databaseUrl,
      DATABASE_URL: opts.databaseUrl,
      PTH_WORKSPACES_PATH: opts.basePath,
      PTH_ARTIFACTS_PATH: opts.artifactPath,
      // toolstore 文件通道：继承主进程 env（默认 <dataDir>/toolstore）
      PTH_TOOLSTORE_PATH: opts.toolstorePath ?? process.env.PTH_TOOLSTORE_PATH ?? "",
      // 自修改（v1）：源码根（worker readSource 只读面——容器 /app/src）
      PTH_SOURCE_ROOT: process.env.PTH_SOURCE_ROOT ?? "/app/src",
      ...opts.env,
    },
  });
  const watchdog = new KernelWatchdog(batchManager);
  watchdog.start(opts.watchdogIntervalMs ?? 30_000);

  // 自修改（v1）：注入源码指南到公共记忆区（developer 单步修改用——幂等）
  try {
    const { injectSelfModifyGuide } = await import("./self-modify.js");
    await injectSelfModifyGuide(dataWorld.memory);
  } catch (e) {
    assemblyLogger?.warn?.(`[self-modify] 指南注入失败（放行）: ${(e as Error).message}`);
  }
  // Prompt 框架化（2026-08-09）：角色文档 + 能力索引入 memory（prompt 数据源——
  // eager 注入 / lazy 指针——新核/新角色零 prompt 改动）
  try {
    const { injectPromptDocs } = await import("./prompt-docs.js");
    await injectPromptDocs(dataWorld.memory);
  } catch (e) {
    assemblyLogger?.warn?.(`[prompt-docs] 文档注入失败（放行）: ${(e as Error).message}`);
  }

  // TaskResolver（任务池即工作流 T3）：独立解析循环（unref 不阻止退出）
  // CPU 优化：空轮询自适应退避 2s→5s→10s→15s（无 flow 任务时降频——resolver 查询是
  // payload ? 'flow' 的 GIN 扫描，任务表大时空轮询浪费）；有任务立即恢复快周期。
  const resolver = new TaskResolver({ taskStore: dataWorld.tasks, pool });
  let resolverDelayMs = opts.resolverIntervalMs ?? 2_000;
  const scheduleResolver = () => {
    const t = setTimeout(async () => {
      try {
        const report = await resolver.resolveLoop();
        // 有处理 → 立即恢复快周期；空 → 指数退避（上限 15s）
        resolverDelayMs = report.processed > 0
          ? (opts.resolverIntervalMs ?? 2_000)
          : Math.min(resolverDelayMs * 2, 15_000);
      } catch (e) {
        console.error(`[resolver] loop error: ${(e as Error).message}`);
      }
      scheduleResolver();
    }, resolverDelayMs);
    t.unref?.();
  };
  scheduleResolver();

  // 兼容性扩展装载（2026-08-09）：toolstore/extensions 扫描 → 角色注册到谱系——
  // 主进程路由（publish 时 routeTaskRole）与 fork 内认领共用 allWorkerRoles。扩展角色
  // 的 worker spawn 由 PTH_WORKER_ROLES/worker-add 配置（默认构成不含扩展角色）。
  const toolstorePath = opts.toolstorePath ?? process.env.PTH_TOOLSTORE_PATH ?? "";
  if (toolstorePath) {
    try {
      const { createToolstore } = await import("./interpreter/toolstore.js");
      const { ExtRegistry } = await import("./extensions/ext-registry.js");
      const reg = new ExtRegistry({
        toolstore: createToolstore(toolstorePath),
        extContext: { log: (m: unknown) => assemblyLogger?.info?.(`[ext] ${String(m)}`) },
      });
      const loaded = await reg.loadAll();
      if (loaded.length > 0) assemblyLogger?.info?.(`[assembly] 扩展装载完成（${loaded.join(",")}）`);
    } catch (e) {
      assemblyLogger?.warn?.(`[assembly] 扩展装载失败（放行——不影响 kernel 启动）: ${(e as Error).message}`);
    }
  }

  // 单大 batch 默认（2026-08-09）：启动即拉 1 个全量构成 batch——worker 级控制为主，
  // batch add/remove 降级为特殊手段。构成 = PTH_WORKER_ROLES 展开（不设置 = 7×1）。
  try {
    const handle = await batchManager.spawnBatch();
    assemblyLogger?.info?.(`[assembly] 默认 batch 已启动（pid=${handle.pid} workers=${handle.workers.length}）`);
  } catch (e) {
    assemblyLogger?.error?.(`[assembly] 默认 batch 启动失败（可手动 batch add）: ${(e as Error).message}`);
  }

  // Claim 超时回收（batch 崩溃/重启僵尸认领）：周期扫描回收 claimed_at 超时任务回 pending
  // 参数：PTH_CLAIM_REAP_MS（扫描周期，默认 30s）/ PTH_CLAIM_TIMEOUT_MS（超时阈值，默认 600s）
  const claimTimeoutMs = Number(process.env.PTH_CLAIM_TIMEOUT_MS ?? 600_000);
  const claimReapMs = Number(process.env.PTH_CLAIM_REAP_MS ?? 30_000);
  const claimReaperTimer = setInterval(() => {
    void dataWorld.tasks
      .recoverStaleClaims(claimTimeoutMs)
      .then((n) => {
        if (n > 0) console.log(`[claim-reaper] recovered ${n} stale claim(s)`);
      })
      .catch((e) => {
        console.error(`[claim-reaper] loop error: ${(e as Error).message}`);
      });
  }, claimReapMs);
  claimReaperTimer.unref?.();

  // Batch 自动扩缩容（PTH_BATCH_AUTOSCALE 默认 off——单大 batch 为主；
  // PTH_AUTOSCALE_MODE=balanced|reinforced：balanced 整 batch 扩容 / reinforced per-role 强化（descheduler））
  const scalerCfg = loadScalerConfig(process.env);
  const autoscaleMode = (process.env.PTH_AUTOSCALE_MODE as "balanced" | "reinforced" | undefined) ?? "balanced";
  let scalerTimer: ReturnType<typeof setInterval> | null = null;
  if (scalerCfg.enabled) {
    const scalerLogger = createKernelLogger();
    scalerTimer = setInterval(() => {
      void evaluateAndScale(
        {
          countPending: () => dataWorld.tasks.countPending(),
          batchCount: async () => (await batchManager.listBatches()).length,
          avgIdleRatio: async () => {
            const bs = await batchManager.listBatches();
            if (bs.length === 0) return 1;
            return bs.reduce((s, b) => s + (b.idleRatio ?? 1), 0) / bs.length;
          },
          spawnBatch: () => batchManager.spawnBatch(),
          countPendingByRole: () => dataWorld.tasks.countPendingByRole(),
          spawnReinforced: (role, copies) => batchManager.spawnBatch({ mode: "reinforced", role, copies }),
          killOneIdle: async () => {
            const bs = await batchManager.listBatches();
            const idle = bs.find((b) => (b.idleRatio ?? 1) >= 1);
            if (!idle) return false;
            await batchManager.killBatch(idle.id);
            return true;
          },
          logger: (msg) => scalerLogger?.info(msg),
        },
        { min: scalerCfg.min, max: scalerCfg.max, upThreshold: scalerCfg.upThreshold, mode: autoscaleMode, roleThreshold: Number(process.env.PTH_AUTOSCALE_ROLE_THRESHOLD ?? 5), reinforceCopies: Number(process.env.PTH_AUTOSCALE_REINFORCE_COPIES ?? 2) },
      ).catch((e) => {
        scalerLogger?.error(`autoscale loop error: ${(e as Error).message}`);
      });
    }, scalerCfg.intervalMs);
    scalerTimer.unref?.();
  }

  return {
    pool,
    dataWorld,
    batchManager,
    watchdog,
    resolver,
    shutdown: async () => {
      watchdog.stop();
      // resolver 走自调度 setTimeout 链——停靠 resolver 对象（无 timer 句柄外泄；unref 不阻止退出）
      (resolver as unknown as { stop?: () => void }).stop?.();
      if (claimReaperTimer) clearInterval(claimReaperTimer);
      if (scalerTimer) clearInterval(scalerTimer);
      await pool.end();
    },
  };
}
