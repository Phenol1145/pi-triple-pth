import type { WorkerKernel } from "../interpreter/index.js";
import type { Task, TaskStore } from "../storage/task-store-pg.js";
import type { WorkerRole } from "./worker-cluster.js";
import { isNaturalLanguageTask, translateTask } from "./nl-translator.js";
import { runAgentTask } from "./agent-loop.js";

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
  /** 自然语言任务转译（NL→代码）；undefined = 不转译（NL 任务直接 reject） */
  llm?: import("../interpreter/llm-fn.js").LlmFn;
  /** agent 循环的 capability 白名单（web/state/fs/memory——与 vm 注入同一份） */
  agentCaps?: Record<string, unknown>;
}

/**
 * 任务循环：peek → claim → 执行 → submit → 转录归档。
 * 语义（裁决 10/11）：peek 只读不锁定先于 claim；claim 即承诺（认领后必 execute 或 reject）；
 *   逐条判别式失败不中断；认领竞态（claimed-by-other）为正常。
 *
 * v1 裁剪（Spec B §5 标注）：机械认领全部候选，无 assess 智能判断——assess（llm.complete
 *   自检候选是否可完成）留 v2 注入。
 * 任务分配正交化（2026-08-08）：candidates 只返回 assigned_role = 自己的任务——
 *   零竞速抢票；零认领 = 自己队列空或全不可认领（坏任务），直接 return 下一轮
 *   （不再 reject assessed-as-unfit——正交化后不存在"更适合的角色"，放回池无意义）。
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

    // 3. 正交化后零认领 = 自己队列空/全不可认领（坏任务）——直接 return 下一轮；
    //    不再 reject assessed-as-unfit（任务只属于自己，放回池无意义）
    if (claimed.length === 0) return;

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
      // 自然语言任务（标签为主要凭据：tags 含 "nl" 或 payload.kind="nl"）
      // 执行路径：LLM agent 循环（PTH 初衷——LLM 理解+多步工具调用）优先；
      // PTH_AGENT_MODE=off 或未注入 caps 时回退一次性转译（fast-path）。
      const nlDetected = isNaturalLanguageTask(task);
      let code = task.text;
      let agentResult: { value: unknown; summary?: string; steps: number } | null = null;
      if (nlDetected) {
        const agentMode = process.env.PTH_AGENT_MODE !== "off";
        if (agentMode && this.deps.llm && this.deps.agentCaps) {
          const r = await runAgentTask({
            llm: this.deps.llm, kernel, caps: this.deps.agentCaps,
            task: { title: task.title, text: task.text },
            role,
            onStep: (s) => taskLogger?.info(`agent step=${s.n} tool=${s.tool} ok=${s.ok}`, { durationMs: s.durationMs }),
          });
          taskLogger?.info("agent task finished", { ok: r.ok, steps: r.steps });
          if (!r.ok) {
            await taskStore.reject(role.id, task.id, r.error, { terminal: true });
            taskLogger?.error(r.error);
            this.deps.onTaskMetric?.({ type: "status", status: "rejected" });
            this.deps.onTaskMetric?.({ type: "reject-reason", reason: classifyReason(r.error) });
            return;
          }
          agentResult = { value: r.value, summary: r.summary, steps: r.steps };
        } else if (this.deps.llm) {
          const t = await translateTask({ llm: this.deps.llm }, { title: task.title, text: task.text });
          if (!t.ok) {
            await taskStore.reject(role.id, task.id, t.error, { terminal: true });
            taskLogger?.error(t.error);
            this.deps.onTaskMetric?.({ type: "status", status: "rejected" });
            this.deps.onTaskMetric?.({ type: "reject-reason", reason: "nl-translate-failed" });
            return;
          }
          code = t.code;
          taskLogger?.info("nl task translated", { codeLen: code.length });
        }
      }
      const result = agentResult
        ? { ok: true, value: agentResult.value, stdout: agentResult.summary ?? "", stderr: "", durationMs: Date.now() - execStart, language: "agent" }
        : await kernel.ts.execute(code, { cwd: ws.dir });
      const execMs = Date.now() - execStart;
      // 性能计量（SPEC L1）：TS 主执行计入 kernel exec（python/bash 由 metered 包装计）
      this.deps.onTaskMetric?.({ type: "exec", language: "ts", durationMs: execMs, ok: result.ok });
      if (!result.ok) {
        // 执行失败（语法/运行时错误——interpreter 返回 ok:false 不抛）：按 reject 处理，
        // 不得标记 completed（试运行发现：SyntaxError 任务被 submit 为 completed，语义错误）。
        await taskStore.reject(role.id, task.id, `execution-failed: ${result.error?.message ?? "unknown"}`, { terminal: true });
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
      // 此刻 context 仍存活，可快照。
      // 性能修复（摸底发现）：refine 的 LLM 调用（1-2s）必须在 execute 循环外异步完成——
      // 否则同角色串行任务被 refine 阻塞（submit 间隔 = 上个任务的 refine 时长）。
      // snapshot 必须同步 await（下一任务 reset 会清 context）；LLM 提炼 fire-and-forget。
      if (this.deps.refiner) {
        // Per-task refine 开关（P6 增强）：payload.refine = "off" 关闭；缺省跟随全局
        const taskRefine = ((task.payload ?? {}) as { refine?: string }).refine;
        if (taskRefine !== "off") {
          try {
            const snap = await this.deps.kernel.snapshot();
            void this.deps.refiner.refine({ task, snapshot: snap }).catch((e) => {
              // 降级：refine 失败仅记日志，任务已 completed 不受影响（草案 P6）
              taskLogger?.error(`refine failed: ${(e as Error).message}`);
            });
          } catch (e) {
            taskLogger?.error(`refine snapshot failed: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      await taskStore.reject(role.id, task.id, `execution-crashed: ${(e as Error).message}`, { terminal: true });
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
