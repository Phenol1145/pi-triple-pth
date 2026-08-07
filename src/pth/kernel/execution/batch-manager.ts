import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

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

  async spawnBatch(): Promise<BatchHandle> {
    const id = randomUUID();
    const workers = this.deps.workers ?? ["analyst", "planner", "developer", "scout", "memory-keeper", "acceptor", "human-interface"];
    const child = fork(this.deps.batchProcessPath, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const record = { id, child, workers, currentTasks: new Map<string, string>() };
    child.on("message", (msg: any) => {
      if (msg?.type === "status" && Array.isArray(msg.tasks)) {
        record.currentTasks = new Map(msg.tasks.map((t: any) => [t.workerId, t.taskId]));
      }
    });
    this.batches.set(id, record);
    return { id, pid: child.pid!, workers, currentTasks: record.currentTasks, idleRatio: 1 };
  }

  async killBatch(id: string): Promise<void> {
    const rec = this.batches.get(id);
    if (!rec) return;
    // 优雅退出：发 shutdown，等 exit（超时 5s 强杀）
    if (rec.child.connected) {
      rec.child.send({ type: "shutdown" });
    }
    await new Promise<void>((resolve) => {
      if (rec.child.exitCode !== null) { resolve(); return; }   // 已退出（如崩溃）则直接返回
      const timer = setTimeout(() => { rec.child.kill("SIGKILL"); resolve(); }, 5000);
      rec.child.once("exit", () => { clearTimeout(timer); resolve(); });
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

  /** v1：统计建议由 stats.suggest 计算（Task 5）；此处接线占位 */
  async suggest(): Promise<{ action: "add" | "remove" | "keep"; reason: string; data: unknown }> {
    const batches = await this.listBatches();
    // Task 7 集成时接 collectStats（需 taskStore）——v1 简单返回 keep
    return { action: "keep", reason: "v1 接线占位（Task 7 接入 collectStats）", data: { batchCount: batches.length } };
  }
}
