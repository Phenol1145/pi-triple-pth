import type { WorkerKernel } from "../interpreter/index.js";
import type { Task, TaskStore } from "../storage/task-store-pg.js";
import type { WorkerRole } from "./worker-cluster.js";

export interface TaskWorkspaceManager {
  allocate(taskId: string): Promise<{ dir: string; tenant: string }>;
  archive(taskId: string, dir: string): Promise<{ artifactPath: string }>;
}

export interface TaskLoopDeps {
  kernel: WorkerKernel;
  role: WorkerRole;
  taskStore: TaskStore;
  workspaceMgr: TaskWorkspaceManager;
  /** Refine 钩子（T4）：任务完成后快照+提炼+持久化。默认 undefined = 不 refine。 */
  refiner?: Pick<import("./refiner.js").Refiner, "refine">;
  /** 日志（日志体系 T2）：链路 ctx（taskId/role）自动携带 */
  logger?: import("../logger.js").KernelLogger;
  /** 性能计量（SPEC L2）：任务事件 → IPC 转发主进程 */
  onTaskMetric?: (m: Record<string, unknown>) => void;
}

/**
 * 任务循环：peek → claim → 执行 → submit → 转录归档。
 * 语义（裁决 10/11）：peek 只读不锁定先于 claim；claim 即承诺（认领后必 execute 或 reject）；
 *   逐条判别式失败不中断；认领竞态（claimed-by-other）为正常。
 *
 * v1 裁剪（Spec B §5 标注）：机械认领全部候选，无 assess 智能判断——assess（llm.complete
 *   自检候选是否可完成）留 v2 注入；空转防护（对抗性审核 I4）：整批候选零认领 → 全部
 *   reject（assessed-as-unfit）放回池，防止 peek/claim 全空导致的无限空转。
 */
export class TaskLoop {
  constructor(private deps: TaskLoopDeps) {}

  async runOnce(): Promise<void> {
    const { taskStore, role } = this.deps;
    // 1. peek：只读获取候选（不锁定）
    const candidates = await taskStore.candidates(role.id);
    if (candidates.length === 0) return;

    // 2. claim（claim 即承诺）：机械认领全部候选；单条认领为空（竞态/不可认领）不中断
    const claimed: Task[] = [];
    for (const task of candidates) {
      const got = await taskStore.claimTopN(role.id, [task.id]);
      if (got.length > 0) claimed.push(got[0]);
    }

    // 3. 空转防护：整批零认领 → 全部 reject 放回池。
    //    assess 智能判定在 Spec B 集成时注入；v1 由「零认领即视为不可执行」兜底
    //    （assessed-as-unfit），避免本批次既无认领又无拒绝的无限空转。
    if (claimed.length === 0) {
      for (const task of candidates) {
        await taskStore.reject(role.id, task.id, "assessed-as-unfit");
      }
      return;
    }

    // 4. 执行已认领任务；认领竞态丢失者跳过——竞态为正常，不 reject
    for (const task of claimed) {
      await this.execute(task);
    }
  }

  private async execute(task: Task): Promise<void> {
    const { kernel, role, taskStore, workspaceMgr } = this.deps;
    const taskLogger = this.deps.logger?.child("taskloop", { taskId: task.id, role: role.id });
    const ws = await workspaceMgr.allocate(task.id);
    const execStart = Date.now();
    kernel.reset();                          // 任务级状态隔离
    try {
      const result = await kernel.ts.execute(task.text, { cwd: ws.dir });
      const execMs = Date.now() - execStart;
      // 性能计量（SPEC L1）：TS 主执行计入 kernel exec（python/bash 由 metered 包装计）
      this.deps.onTaskMetric?.({ type: "exec", language: "ts", durationMs: execMs, ok: result.ok });
      if (!result.ok) {
        // 执行失败（语法/运行时错误——interpreter 返回 ok:false 不抛）：按 reject 处理，
        // 不得标记 completed（试运行发现：SyntaxError 任务被 submit 为 completed，语义错误）。
        await taskStore.reject(role.id, task.id, `execution-failed: ${result.error?.message ?? "unknown"}`);
        await this.archive(task, ws, result);
        taskLogger?.error(`task rejected: ${result.error?.message ?? "unknown"}`, { durationMs: execMs });
        // 性能计量（SPEC L2）：状态 + 拒绝原因（前缀分类）+ 阶段耗时
        this.deps.onTaskMetric?.({ type: "status", status: "rejected" });
        this.deps.onTaskMetric?.({ type: "reject-reason", reason: classifyReason(result.error?.message ?? "unknown") });
        this.deps.onTaskMetric?.({ type: "stage", stage: "execute", durationMs: execMs });
        return;
      }
      await taskStore.submit(role.id, task.id, { ref: result });
      await this.archive(task, ws, result);
      taskLogger?.info("task completed", { durationMs: execMs });
      this.deps.onTaskMetric?.({ type: "status", status: "completed" });
      this.deps.onTaskMetric?.({ type: "stage", stage: "execute", durationMs: execMs });
      // Refine（T4）：任务完成后快照+提炼+持久化。kernel.reset 在下一任务才调用——
      // 此刻 context 仍存活，可快照。refine 失败不阻塞任务完成（旁路降级）。
      if (this.deps.refiner) {
        // Per-task refine 开关（P6 增强）：payload.refine = "off" 关闭；缺省跟随全局
        const taskRefine = ((task.payload ?? {}) as { refine?: string }).refine;
        if (taskRefine !== "off") {
          try {
            const snap = await this.deps.kernel.snapshot();
            await this.deps.refiner.refine({ task, snapshot: snap });
          } catch (e) {
            // 降级：refine 失败仅记日志，任务已 completed 不受影响（草案 P6）
            taskLogger?.error(`refine failed: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      await taskStore.reject(role.id, task.id, `execution-crashed: ${(e as Error).message}`);
      taskLogger?.error(`task crashed: ${(e as Error).message}`);
      this.deps.onTaskMetric?.({ type: "status", status: "rejected" });
      this.deps.onTaskMetric?.({ type: "reject-reason", reason: "execution-crashed" });
    }
  }

  /** 转录归档钩子（Task 4 实现 archiveTask；此处默认归档工作区产物——测试可覆写） */
  protected async archive(task: Task, ws: { dir: string }, result: unknown): Promise<void> {
    // 默认：归档工作区（产物）——完整转录归档在 Task 4 接入
    await this.deps.workspaceMgr.archive(task.id, ws.dir);
  }
}

/** 拒绝原因前缀分类（SPEC L2：防 label 基数爆炸） */
export function classifyReason(reason: string): string {
  if (reason.startsWith("execution-failed")) return "execution-failed";
  if (reason.startsWith("execution-crashed")) return "execution-crashed";
  if (reason.startsWith("assessed-as-unfit")) return "assessed-unfit";
  if (reason.includes("timed out")) return "timeout";
  return "other";
}
