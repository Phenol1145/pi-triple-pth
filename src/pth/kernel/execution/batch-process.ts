import { mkdir } from "node:fs/promises";
import { createPgPool } from "../storage/pg.js";
import { applySchema } from "../storage/schema.js";
import { createDataWorld } from "../storage/index.js";
import { createWorkerKernel } from "../interpreter/index.js";
import type { InterpreterResult } from "../interpreter/types.js";
import type { Task } from "../storage/task-store-pg.js";
import { DEFAULT_ROLES } from "./worker-cluster.js";
import { TaskLoop, type TaskLoopDeps } from "./task-loop.js";
import { DefaultTaskWorkspaceManager } from "./workspace.js";
import { archiveTask, type ArchiveDeps } from "./archive.js";
import { createKernelModelRouter } from "./model-router.js";

export interface RunBatchProcessDeps {
  databaseUrl: string;
  basePath: string;       // 工作区根（workspaces）
  artifactPath: string;   // 产物归档根（artifacts）
  intervalMs?: number;
}

/**
 * 转录归档接线（Task 4 接入）：TaskLoop 的 protected archive 钩子默认只归档工作区产物；
 * 本类覆写为完整转录归档（archiveTask = 转录入 pg + 产物 rename + 清理提示）。
 * 侵入最小（不改 TaskLoop）：archiveDeps 携带与 TaskLoop 同一 workspaceMgr 实例
 * （产物 rename 基于同一工作区路径）。
 */
class BatchTaskLoop extends TaskLoop {
  private archiveDeps: ArchiveDeps;

  constructor(deps: TaskLoopDeps, archiveDeps: ArchiveDeps) {
    super(deps);
    this.archiveDeps = archiveDeps;
  }

  protected async archive(task: Task, ws: { dir: string }, result: unknown): Promise<void> {
    await archiveTask(task, ws, result as InterpreterResult, this.archiveDeps);
  }
}

/**
 * batch 子进程主函数（方案 C，裁决 15）：pth 主进程 fork 本文件。
 * 自驱动：轮询 taskStore → 全角色 worker 各跑 TaskLoop.runOnce。
 * IPC：收 shutdown → 立即退出；收 pause/resume → 暂停/恢复认领。
 * 不 resolve：子进程长驻（pg 连接池维持存活），主进程通过 IPC 终止。
 */
export async function runBatchProcess(deps: RunBatchProcessDeps): Promise<void> {
  const pool = await createPgPool({ connectionString: deps.databaseUrl });
  await applySchema(pool);
  const dataWorld = createDataWorld(pool);
  const workspaceMgr = new DefaultTaskWorkspaceManager({ basePath: deps.basePath, artifactPath: deps.artifactPath });
  // 产物根必须先存在：archive 用 rename 而非 mkdir——父目录缺失时 rename 抛 ENOENT
  await mkdir(deps.artifactPath, { recursive: true });

  // modelRouter：SDK ModelRuntime（自动加载 pi auth.json/models-store——deepseek 已配置）。
  // 真实 LLM 能力（转写/记忆任务依赖）；失败时不阻塞——v1 机械认领仍可用。
  let modelRouter: any;
  try {
    modelRouter = await createKernelModelRouter({
      provider: process.env.PTH_MODEL_PROVIDER ?? "deepseek",
      model: process.env.PTH_MODEL ?? "deepseek-v4-flash",
    });
  } catch (err) {
    console.error("batch process: model router init failed (falling back to stub):", String(err));
    modelRouter = { resolve: () => ({ id: "none", api: "none" }), getRuntime: () => ({}) } as any;
  }

  let paused = false;
  process.on("message", (msg: any) => {
    if (msg?.type === "shutdown") {
      process.exit(0);
    } else if (msg?.type === "pause") {
      paused = true;
    } else if (msg?.type === "resume") {
      paused = false;
    }
  });
  // 父进程退出（IPC 通道关闭）→ 自杀：不留孤儿 batch 继续轮询 DB
  process.on("disconnect", () => process.exit(0));

  const archiveDeps: ArchiveDeps = {
    transcriptStore: dataWorld.transcripts,
    workspaceMgr,
    emitCleanup: (info) => process.send?.({ type: "cleanup", taskId: info.taskId, artifactPath: info.artifactPath }),
  };

  const intervalMs = deps.intervalMs ?? 1000;
  const loops = DEFAULT_ROLES.map((role) => {
    const kernel = createWorkerKernel({ modelRouter, dataWorld });
    return new BatchTaskLoop({ kernel, role, taskStore: dataWorld.tasks, workspaceMgr }, archiveDeps);
  });

  // 每轮：各 worker runOnce（并发）
  const tick = async () => {
    if (paused) return;
    await Promise.all(loops.map((l) => l.runOnce()));
  };

  await tick();   // 立即跑一轮
  const timer = setInterval(tick, intervalMs);
  // 每轮后发 status 给主进程（v1：tasks 占位空——BatchManager 消费 {type,tasks} 契约）
  const statusTimer = setInterval(() => {
    process.send?.({ type: "status", tasks: [] });
  }, 2000);
  // keep-alive（试运行发现修正）：pg 连接池在 Node 24 下不 hold 事件循环（socket 默认 unref），
  // 空闲且仅剩 unref 定时器时进程会立即退出——batch 必须保持存活直到主进程显式 shutdown。
  // 保持定时器引用（不 unref）：进程生命周期与 batch 运行绑定，由 killBatch 的 shutdown 消息
  // 优雅终止（或 5s SIGKILL 兜底）。
  void timer;
  void statusTimer;
}

// 入口判断：env 标志为主（strip-types/transform-types 下 argv[1] 是绝对路径，endsWith 不可靠），
// argv 兜底兼容直接 node 运行。
if (process.env.PTH_BATCH_PROCESS === "1" || process.argv[1]?.endsWith("batch-process.ts")) {
  const databaseUrl = process.env.PTH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("batch process fatal: missing database url (PTH_TEST_DATABASE_URL or DATABASE_URL)");
    process.exit(1);
  }
  const basePath = process.env.PTH_WORKSPACES_PATH ?? "/tmp/pth-workspaces";
  const artifactPath = process.env.PTH_ARTIFACTS_PATH ?? "/tmp/pth-artifacts";
  runBatchProcess({ databaseUrl, basePath, artifactPath }).catch((e) => {
    console.error("batch process fatal:", e);
    process.exit(1);
  });
}
