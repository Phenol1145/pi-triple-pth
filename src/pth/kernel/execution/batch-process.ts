import { mkdir } from "node:fs/promises";
import { createPgPool } from "../storage/pg.js";
import { applySchema } from "../storage/schema.js";
import { createDataWorld } from "../storage/index.js";
import { createWorkerKernel, createWorkerKernelWithManager, createKernelManager } from "../interpreter/index.js";
import type { InterpreterResult } from "../interpreter/types.js";
import type { Task } from "../storage/task-store-pg.js";
import { DEFAULT_ROLES, allWorkerRoles, parseRoleWeights, expandRoleWeights } from "./worker-cluster.js";
import { getEventBus } from "./event-bus.js";
import { TaskLoop, type TaskLoopDeps } from "./task-loop.js";
import { DefaultTaskWorkspaceManager } from "./workspace.js";
import { archiveTask, type ArchiveDeps } from "./archive.js";
import { createKernelModelRouter } from "./model-router.js";
import { createLlmFn } from "../interpreter/llm-fn.js";
import { Refiner } from "./refiner.js";
import { createToolstore } from "../interpreter/toolstore.js";
import { createKernelLogger } from "../logger.js";
import { loadKernelConfig } from "../interpreter/kernel-config.js";

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
  // 内存优化：连接池收紧（7 角色 worker 并发 ≤7——max 8 够；默认 10 冗余）
  // PTH_PG_POOL_MAX 可覆盖（batch 数多时 PG 连接总量 = pool_max × batches 需核算）
  const pool = await createPgPool({ connectionString: deps.databaseUrl, max: Number(process.env.PTH_PG_POOL_MAX ?? 8) });
  await applySchema(pool);
  const dataWorld = createDataWorld(pool);
  const workspaceMgr = new DefaultTaskWorkspaceManager({ basePath: deps.basePath, artifactPath: deps.artifactPath });
  // 产物根必须先存在：archive 用 rename 而非 mkdir——父目录缺失时 rename 抛 ENOENT
  await mkdir(deps.artifactPath, { recursive: true });

  // 日志（日志体系 T2/T3）：IPC 转发主进程统一打标；stdio 兜底
  const logger = createKernelLogger({
    ipcSend: (msg) => { try { process.send?.(msg); } catch { /* IPC 不可用 */ } },
  });
  const batchLogger = logger.child("batch", { pid: process.pid });

  // modelRouter：SDK ModelRuntime（自动加载 pi auth.json/models-store——deepseek 已配置）。
  // 真实 LLM 能力（转写/记忆任务依赖）；失败时不阻塞——v1 机械认领仍可用。
  let modelRouter: any;
  try {
    modelRouter = await createKernelModelRouter({
      provider: process.env.PTH_MODEL_PROVIDER ?? "deepseek",
      model: process.env.PTH_MODEL ?? "deepseek-v4-flash",
    });
  } catch (err) {
    batchLogger.warn("model router init failed (falling back to stub)", { err: String(err) });
    modelRouter = { resolve: () => ({ id: "none", api: "none" }), getRuntime: () => ({}) } as any;
  }

  // 兼容性扩展装载（fork 内注册角色——扩展角色任务可认领/worker-add）——toolstore 路径 env 注入
  {
    const extPath = process.env.PTH_TOOLSTORE_PATH ?? "";
    if (extPath) {
      try {
        const { createToolstore } = await import("../interpreter/toolstore.js");
        const { ExtRegistry } = await import("../extensions/ext-registry.js");
        const reg = new ExtRegistry({ toolstore: createToolstore(extPath), extContext: { log: () => {} } });
        await reg.loadAll();
      } catch (e) {
        batchLogger?.warn?.(`[ext] fork 内扩展装载失败（放行）: ${(e as Error).message}`);
      }
    }
  }

  let paused = false;

  /** 退出前释放全部 worker kernel（sandbox acquire 归还——防池泄漏）——幂等 */
  let disposed = false;
  async function disposeAllKernels(): Promise<void> {
    if (disposed) return;
    disposed = true;
    for (const l of loops) {
      const k = (l as unknown as { kernel?: { dispose?: () => Promise<void> | void } }).kernel;
      try { await k?.dispose?.(); } catch { /* dispose 容错 */ }
    }
  }
  // 进程级兜底（2026-08-09 端到端：refine snapshot abort 未 catch 处杀 batch → watchdog 30s 循环）。
  // 异步异常记日志不崩——sandbox 瞬时故障不应终止 batch（降级容忍——后续调用自动恢复）。
  process.on("unhandledRejection", (reason) => {
    batchLogger?.error(`[batch] unhandledRejection（容忍——不终止）: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    batchLogger?.error(`[batch] uncaughtException（容忍——不终止）: ${err.message}`);
  });

  // 优雅退出：SIGTERM/SIGINT/disconnect/exit-message 统一先释放 kernel 再 exit（防 sandbox 池泄漏）
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => { void disposeAllKernels().finally(() => process.exit(0)); });
  }
  const exitNow = (code: number) => () => process.exit(code);
  process.on("exit", (code) => { if (!disposed) void disposeAllKernels().finally(() => exitNow(code)); });

  process.on("message", (msg: any) => {
    if (msg?.type === "shutdown") {
      void disposeAllKernels().finally(() => process.exit(0));
    } else if (msg?.type === "pause") {
      paused = true;
    } else if (msg?.type === "resume") {
      paused = false;
    } else if (msg?.type === "worker-pause" && typeof msg.role === "string") {
      getEventBus().emit("worker.pause", { role: msg.role, batchPid: process.pid });
      for (const l of loops) if (l.role.id === msg.role) l.pause();
      process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "paused" });
    } else if (msg?.type === "worker-resume" && typeof msg.role === "string") {
      getEventBus().emit("worker.resume", { role: msg.role, batchPid: process.pid });
      for (const l of loops) if (l.role.id === msg.role) l.resume();
      process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "active" });
    } else if (msg?.type === "worker-remove" && typeof msg.role === "string") {
      getEventBus().emit("worker.remove", { role: msg.role, batchPid: process.pid });

      // 防御：tick 自驱动链与 splice 并发——map 回调可能拿到已移除的 undefined（竞态窗口）
      const idxs = loops.map((l, i) => (l && l.role?.id === msg.role ? i : -1)).filter((i) => i >= 0);
      for (const i of idxs.reverse()) {
        const l = loops[i]!;
        l.stop();
        // kernel dispose（释放 python 子进程）
        const k = (l as unknown as { kernel?: { dispose?: () => void } }).kernel;
        try { k?.dispose?.(); } catch { /* dispose 容错 */ }
        loops.splice(i, 1);
      }
      process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "removed" });
    } else if (msg?.type === "worker-add" && typeof msg.role === "string") {
      getEventBus().emit("worker.add", { role: msg.role, copies: msg.copies ?? 1, batchPid: process.pid });
      const roleDef = allWorkerRoles().find((r) => r.id === msg.role);
      if (roleDef) {
        const copies = Number(msg.copies ?? 1);
        for (let i = 0; i < copies; i++) createWorker(roleDef);
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "added", copies });
      } else {
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "error", error: "unknown role" });
      }
    }
  });
  // 父进程退出（IPC 通道关闭）→ 自杀：不留孤儿 batch 继续轮询 DB（先释放 kernel）
  process.on("disconnect", () => { void disposeAllKernels().finally(() => process.exit(0)); });

  const archiveDeps: ArchiveDeps = {
    transcriptStore: dataWorld.transcripts,
    workspaceMgr,
    emitCleanup: (info) => process.send?.({ type: "cleanup", taskId: info.taskId, artifactPath: info.artifactPath }),
  };

  const intervalMs = deps.intervalMs ?? Number(process.env.PTH_BATCH_TICK_MS ?? 1000);
  // 多语言持久 REPL（T1-T3）：KernelManager 路由——python/bash 用持久 kernel
  // （实测 230x vs spawn）；sandbox 生产模式可用 env 切换（PTH_PYTHON_MODE/PTH_BASH_MODE）
  // toolstore 文件通道（§0.5）：PTH_TOOLSTORE_PATH 或默认 toolstore/（相对工作目录）
  const toolstoreDir = process.env.PTH_TOOLSTORE_PATH ?? "toolstore";
  await mkdir(toolstoreDir, { recursive: true }).catch(() => {});
  const toolstore = createToolstore(toolstoreDir);
  // batch 构成参数化（PTH_WORKER_ROLES）：任意角色子集 + 副本数（0 禁用）；
  // 不设置 → 默认 7 角色 ×1（原行为）。启动时解析一次——运行时改权重需 batch remove+add。
  const workerRoles = expandRoleWeights(parseRoleWeights(process.env.PTH_WORKER_ROLES));
  // worker 注册表（worker 级控制面：pause/resume/remove/add——IPC 指令寻址）
  const loops: Array<BatchTaskLoop & { role: import("./worker-cluster.js").WorkerRole }> = [];

  /** 创建并注册一个角色 worker（P3 动态 add 复用；remove 后 dispose kernel 回收 python 进程） */
  const createWorker = (role: import("./worker-cluster.js").WorkerRole) => {
    const manager = createKernelManager({
      pythonMode: (process.env.PTH_PYTHON_MODE as any) ?? "kernel",
      bashMode: (process.env.PTH_BASH_MODE as any) ?? "kernel",
      // kernel sandbox 接线：sandbox-kernel 模式连宿主（url/secret 与 bash 转发同源）
      sandboxKernel: {
        url: process.env.PTH_SANDBOX_KERNEL_URL ?? "http://sandbox:8080",
        secret: process.env.SANDBOX_SHARED_SECRET ?? "",
      },
      // kernel 参数化（PTH_KERNEL_* env）：懒 spawn / 空闲回收 / reset 模式
      kernelConfig: loadKernelConfig(process.env),
      // 日志体系 T4：kernel stderr 转发 warn（component=pykernel/bashkernel）
      onKernelStderr: (language, line) => batchLogger.child(language === "python" ? "pykernel" : "bashkernel")?.warn(line.trim()),
      // 性能计量（SPEC L1）：kernel 执行事件 → IPC 转发主进程
      onKernelMetric: (metric) => {
        try { process.send?.({ kind: "metric", metric }); } catch { /* IPC 不可用 */ }
      },
    });
    const llm = createLlmFn({
      modelRouter,
      // 性能计量（SPEC L0-④）：llm 事件 → IPC 转发主进程
      onMetric: (m) => {
        try { process.send?.({ kind: "metric", metric: { ...m, kind: "llm" } }); } catch { /* IPC 不可用 */ }
      },
    });
    // 权限分层（P3——注入面收窄）：角色声明的 capabilities/memoryScope 传给能力构建
    const kernel = createWorkerKernelWithManager({
      llm, dataWorld, manager, toolstore,
      roleFilter: role.capabilities,
      memoryScope: role.memoryScope ? { role: role.id, scope: role.memoryScope } : undefined,
      registerKernel: (language, interpreter) => manager.registerKernel(language, interpreter as never),
    });
    // Refine 钩子（T4，裁决 P6：默认 auto——任务完成后自动提炼；PTH_REFINE=off 关闭）
    const refineEnabled = process.env.PTH_REFINE !== "off";
    const refiner = refineEnabled ? new Refiner({
      llm: createLlmFn({
        modelRouter,
        onMetric: (m) => { try { process.send?.({ kind: "metric", metric: { ...m, kind: "llm" } }); } catch { /* IPC 不可用 */ } },
      }),
      memory: dataWorld.memory,
      onMetric: (m) => { try { process.send?.({ kind: "metric", metric: { ...m, domain: "refine" } }); } catch { /* IPC 不可用 */ } },
    }) : undefined;
    const loop = new BatchTaskLoop({
      kernel, role, taskStore: dataWorld.tasks, workspaceMgr, refiner, logger: batchLogger,
      // 自然语言任务转译（NL→代码）：复用角色自身的 llm（与 refine 同源）
      llm,
      // agent 循环的 capability 白名单（与 vm 注入同一份）
      agentCaps: kernel.capabilities,
      // 性能计量（SPEC L2）：任务事件 → IPC 转发主进程
      onTaskMetric: (m) => { try { process.send?.({ kind: "metric", metric: { ...m, domain: "task" } }); } catch { /* IPC 不可用 */ } },
    }, archiveDeps);
    (loop as unknown as { kernel?: unknown }).kernel = kernel;   // remove 时 dispose 用
    (loop as unknown as { role?: import("./worker-cluster.js").WorkerRole }).role = role;  // remove 寻址用
    loops.push(loop as BatchTaskLoop & { role: import("./worker-cluster.js").WorkerRole });
    return loop;
  };

  workerRoles.forEach((role) => createWorker(role));

  // 每轮：各 worker runOnce（并发）；didWork=true（有任务执行完）→ 立即自驱动下一轮
  // （吞吐优化：串行任务零轮询等待——0.58s/任务 的轮询延迟消除）；
  // 空闲（无候选）退避回 intervalMs timer，避免空转查询 PG。
  const tick = async (): Promise<void> => {
    if (paused) return;
    // 快照遍历（worker-remove 的 splice 并发安全——过滤已移除项）
    const snapshot = loops.filter((l): l is typeof l => Boolean(l));
    const did = await Promise.all(snapshot.map((l) => l.runOnce()));
    if (did.some(Boolean)) void tick();   // 忙时自驱动（串行链——防风暴）
    else return;                          // 空闲：等 timer 下一轮
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
