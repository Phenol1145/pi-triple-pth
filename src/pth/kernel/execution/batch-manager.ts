import { fork, type ChildProcess } from "node:child_process";
import { type BatchProfile, profileToWeights, expandRoleWeights, weightsToEnv } from "./worker-cluster.js";
import { randomUUID } from "node:crypto";
import type { BatchSuggestion } from "./stats.js";

export interface BatchHandle {
  id: string;
  pid: number;
  workers: string[];
  currentTasks: Map<string, string>;
  idleRatio: number;
}

// 与 Task 5 stats.ts 的 BatchStatusLike 契约对齐（id/workers/currentTasks 字段兼容，可直喂 collectStats）
export interface BatchStatus {
  id: string;
  pid: number;
  workers: string[];
  currentTasks: Record<string, string>;   // workerId → taskId
  idleRatio: number;
}

export interface BatchManagerDeps {
  batchProcessPath: string;    // batch-process.ts（Task 7 建；v1 测试用 stub）
  workers?: string[];          // v1 全角色 7 个
  /** 生产 fork 透传（Task 4）：TS 入口需 --experimental-transform-types + resolve-hook loader */
  execArgv?: string[];
  /** 生产 fork 环境透传（Task 4）：PTH_BATCH_PROCESS/PTH_TEST_DATABASE_URL 等 */
  env?: Record<string, string>;
  /** 日志（日志体系 T3）：batch IPC log 消息 → 主进程统一打标 */
  logger?: import("../logger.js").KernelLogger;
  /** 性能计量（SPEC L1）：batch IPC metric 消息 → 主进程 kernelMetrics */
  onMetric?: (m: Record<string, unknown>) => void;
  /** obs 观测请求解析器（主进程装配：metrics/batches 数据源）——batch obs-req 消息路由 */
  obsResolver?: (req: string, params: unknown) => Promise<unknown>;
}

/**
 * batch 管理：pth 主进程 fork batch 子进程（方案 C，裁决 15）。
 * IPC 协议（对抗性审核 I7）：
 *   主 → batch: {type:"shutdown"} | {type:"pause"} | {type:"resume"}
 *   batch → 主: {type:"status", tasks:[{workerId,taskId}]} | {type:"error", message}
 */
export class BatchManager {
  private batches = new Map<string, { id: string; child: ChildProcess; workers: string[]; currentTasks: Map<string, string> }>();

  constructor(private deps: BatchManagerDeps) {}

  /** spawnBatch：默认构成（deps.workers）或按 BatchProfile 指定（balanced 权重 / reinforced 单角色） */
  async spawnBatch(profile?: BatchProfile): Promise<BatchHandle> {
    const id = randomUUID();
    // profile → 权重展开（workers id 数组）+ env 序列化（PTH_WORKER_ROLES——子进程自行解析一致）
    let workers: string[];
    let envOverride: Record<string, string> = {};
    if (profile) {
      const weights = profileToWeights(profile);
      workers = expandRoleWeights(weights).map((r) => r.id);
      envOverride = { PTH_WORKER_ROLES: weightsToEnv(weights) };
    } else {
      workers = this.deps.workers ?? ["analyst", "planner", "developer", "scout", "memory-keeper", "acceptor", "human-interface"];
    }
    const child = fork(this.deps.batchProcessPath, [], {
      execArgv: this.deps.execArgv,
      env: this.deps.env ? { ...process.env, ...this.deps.env, ...envOverride } : undefined,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const record = { id, child, workers, currentTasks: new Map<string, string>() };
    child.on("message", (msg: any) => {
      if (msg?.type === "status" && Array.isArray(msg.tasks)) {
        record.currentTasks = new Map(msg.tasks.map((t: any) => [t.workerId, t.taskId]));
      } else if (msg?.kind === "obs-req" && this.deps.obsResolver) {
        // obs 观测请求（batch → 主进程）：解析并回传（obs-resp 契约）
        const id = String(msg.id ?? "");
        void this.deps.obsResolver(String(msg.req ?? ""), msg.params)
          .then((data) => {
            try { record.child.send({ kind: "obs-resp", id, data }); } catch { /* 子进程已退容忍 */ }
          })
          .catch((e: Error) => {
            try { record.child.send({ kind: "obs-resp", id, data: null, error: e.message }); } catch { /* 同上 */ }
          });
      } else if (msg?.type === "log" && this.deps.logger) {
        // 日志体系 T3：batch 子进程日志经 IPC 转发 → 主进程统一打标（component/pid）
        const { level, component, msg: logMsg, ctx } = msg as {
          level: string; component: string; msg: string; ctx?: Record<string, unknown>;
        };
        const l = this.deps.logger.child(component, { ...(ctx ?? {}), batchPid: record.child.pid });
        if (level === "warn") l.warn(logMsg);
        else if (level === "error") l.error(logMsg);
        else if (level === "debug") l.debug(logMsg);
        else l.info(logMsg);
      } else if (msg?.kind === "metric") {
        // 性能计量（SPEC L1）：batch kernel/llm 事件 → 主进程 kernelMetrics
        this.deps.onMetric?.(msg.metric as Record<string, unknown>);
      }
    });
    // Finding #3: 持久 error handler——fork 失败（路径无效）/ IPC 错误不再 crash 主进程。
    // spawn 阶段失败时 record 未登记（delete 为 no-op）；spawn 成功后的 IPC 错误则从 Map 清理。
    child.on("error", () => {
      this.batches.delete(id);
      child.removeAllListeners("message");
    });
    // 等 spawn 或 error 决出。实测（Node 24）：fork 的无效模块路径 → spawn 成功（node 二进制
    // 必然存在），子进程加载失败退出(1)，父进程不发 'error'；'error' 仅在 IPC/kill 等通道错误时触发。
    // 该竞态仍为通道类错误提供 spawn 阶段 reject 路径；spawn 成功后的 'error' 由上方持久 handler 清理。
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        child.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        child.off("spawn", onSpawn);
        reject(err);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    this.batches.set(id, record);
    return { id, pid: child.pid!, workers, currentTasks: record.currentTasks, idleRatio: 1 };
  }

  // ── worker 级控制面（2026-08-09 单大 batch 启停灵活性）──────────────────
  private workerCtl(batchId: string, msg: Record<string, unknown>): Promise<boolean> {
    const rec = this.batches.get(batchId);
    if (!rec) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        if (rec.child.connected) {
          rec.child.send(msg);
          resolve(true);
        } else resolve(false);
      } catch { resolve(false); }
    });
  }

  async pauseWorker(batchId: string, role: string): Promise<boolean> {
    return this.workerCtl(batchId, { type: "worker-pause", role });
  }
  async resumeWorker(batchId: string, role: string): Promise<boolean> {
    return this.workerCtl(batchId, { type: "worker-resume", role });
  }
  async removeWorker(batchId: string, role: string): Promise<boolean> {
    return this.workerCtl(batchId, { type: "worker-remove", role });
  }
  async addWorker(batchId: string, role: string, copies = 1): Promise<boolean> {
    return this.workerCtl(batchId, { type: "worker-add", role, copies });
  }

  async killBatch(id: string): Promise<void> {
    const rec = this.batches.get(id);
    if (!rec) return;
    // Finding #1: connected 检查通过后、send 前子进程可能并发退出 → send 抛 ERR_IPC_CHANNEL_CLOSED。
    // try/catch 包裹：抛错不阻断后续清理（delete 仍执行），走退出等待兜底。
    try {
      if (rec.child.connected) {
        rec.child.send({ type: "shutdown" });
      }
    } catch {
      // channel 已关闭：忽略，下方 exitCode/signalCode/exit 事件兜底
    }
    // 优雅退出：发 shutdown，等 exit（超时 5s 强杀）
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        rec.child.kill("SIGKILL");
        finish();
      }, 5000);
      // Finding #2: 先挂 exit 监听，再查退出状态——避免"检查 exitCode 后、挂监听前"
      // 的微任务窗口内子进程退出导致 exit 漏接（挂满 5s SIGKILL 超时）。
      rec.child.once("exit", finish);
      // signalCode 覆盖"被信号杀死"场景（exitCode 为 null 但进程已死）
      if (rec.child.exitCode !== null || rec.child.signalCode !== null) {
        finish();
      }
    });
    this.batches.delete(id);
  }

  async listBatches(): Promise<BatchStatus[]> {
    const out: BatchStatus[] = [];
    for (const rec of this.batches.values()) {
      const total = rec.workers.length;
      const busy = rec.currentTasks.size;
      out.push({
        id: rec.id,
        pid: rec.child.pid!,
        workers: rec.workers,
        currentTasks: Object.fromEntries(rec.currentTasks),
        idleRatio: total === 0 ? 1 : (total - busy) / total,
      });
    }
    return out;
  }

  /** 存活判定（装配层 watchdog 消费）：batch 仍在运行（exitCode/signalCode 均未决）。 */
  isBatchAlive(id: string): boolean {
    const rec = this.batches.get(id);
    if (!rec) return false;
    return rec.child.exitCode === null && rec.child.signalCode === null && !rec.child.killed;
  }
  async suggest(): Promise<BatchSuggestion> {
    const batches = await this.listBatches();
    // Task 7 集成时接 collectStats（需 taskStore）——v1 简单返回 keep；
    // data 填完整形状（契约收敛，Task 5 BatchSuggestion）；pendingCount/idleRatio 为占位值，Task 7 接真实统计。
    return { action: "keep", reason: "v1 接线占位（Task 7 接入 collectStats）", data: { pendingCount: 0, idleRatio: 1, batchCount: batches.length } };
  }
}
