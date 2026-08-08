import { createPgPool, applySchema, createDataWorld } from "./storage/index.js";
import { BatchManager } from "./execution/batch-manager.js";
import { DEFAULT_ROLES } from "./execution/worker-cluster.js";
import { TaskResolver } from "./execution/task-resolver.js";
import { createKernelLogger } from "./logger.js";
import type pg from "pg";

export interface KernelRuntimeOptions {
  databaseUrl: string;
  basePath: string;       // 工作区根（workspaces）
  artifactPath: string;   // 产物归档根（artifacts）
  batchProcessPath?: string;  // batch-process 入口（默认按运行环境解析：dist 优先，src 兜底）
  execArgv?: string[];    // 生产 fork 透传（TS 源码模式：transform-types + resolve-hook loader）
  env?: Record<string, string>;  // 生产 fork 环境透传（PTH_BATCH_PROCESS/DATABASE_URL 等）
  toolstorePath?: string;  // toolstore 文件通道目录（默认继承主进程 env）
  watchdogIntervalMs?: number; // watchdog 探测周期（默认 30s）
  resolverIntervalMs?: number; // TaskResolver 解析轮询周期（默认 2s）
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
 * 按运行环境解析 batch-process 入口：dist 编译产物存在（生产）→ dist；
 * 否则（dev 源码模式）→ src TS。execArgv/env 由调用方按模式决定（生产纯 js 无需 loader）。
 */
function resolveBatchProcessPath(explicit: string | undefined): string {
  if (explicit) return explicit;
  return "dist/pth/kernel/execution/batch-process.js";
}

export async function createKernelRuntime(opts: KernelRuntimeOptions): Promise<KernelRuntime> {
  const pool = await createPgPool({ connectionString: opts.databaseUrl });
  await applySchema(pool);

  const dataWorld = createDataWorld(pool);
  const batchManager = new BatchManager({
    batchProcessPath: resolveBatchProcessPath(opts.batchProcessPath),
    workers: DEFAULT_ROLES.map((r) => r.id),
    execArgv: opts.execArgv,
    logger: createKernelLogger(),
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
      ...opts.env,
    },
  });
  const watchdog = new KernelWatchdog(batchManager);
  watchdog.start(opts.watchdogIntervalMs ?? 30_000);

  // TaskResolver（任务池即工作流 T3）：独立解析循环（2s 轮询，unref 不阻止退出）
  const resolver = new TaskResolver({ taskStore: dataWorld.tasks, pool });
  const resolverTimer = setInterval(() => {
    void resolver.resolveLoop().catch((e) => {
      console.error(`[resolver] loop error: ${(e as Error).message}`);
    });
  }, opts.resolverIntervalMs ?? 2_000);
  resolverTimer.unref?.();

  return {
    pool,
    dataWorld,
    batchManager,
    watchdog,
    resolver,
    shutdown: async () => {
      watchdog.stop();
      clearInterval(resolverTimer);
      await pool.end();
    },
  };
}
