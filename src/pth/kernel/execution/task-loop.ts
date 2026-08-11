import type { WorkerKernel } from "../interpreter/index.js";
import type { Task, TaskStore } from "../storage/task-store-pg.js";
import type { WorkerRole } from "./worker-cluster.js";
import { translateTask } from "./nl-translator.js";
import { runAgentTask } from "./agent-loop.js";
import { getEventBus } from "./event-bus.js";

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
  /** 活动事件流（console --follow 数据源）：任务接取/agent step（含 token 用量）/完成——实时上报 */
  onActivity?: (e: { kind: string; taskId?: string; role?: string; step?: number; tool?: string; ok?: boolean; usage?: { inputTokens?: number; outputTokens?: number }; detail?: string; chainDepth?: number; triggerId?: string }) => void;
  /** 运行过程保留（2026-08-09）：transcript store（agent 轨迹持久化） */
  transcripts?: { create(input: { taskId?: string; agentId: string; body: unknown[]; summary?: string }): Promise<string> };
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

  /** runOnce：执行一轮认领。返回 true = 本轮有任务执行（调用方可自驱动下一轮——吞吐优化） */
  // worker 级控制（2026-08-09 单大 batch 控制面）：pause=暂停认领（保留状态）/
  // resume=恢复 / stop=永久停止（dispose 由调用方处理）
  /** 事件总线（兼容性扩展接口 P1）：batch 内就近 emit（多 batch 天然隔离） */
  private get bus() { return getEventBus(); }
  private paused = false;
  private stopped = false;

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  stop(): void { this.stopped = true; }
  get isPaused(): boolean { return this.paused; }
  get isStopped(): boolean { return this.stopped; }

  async runOnce(): Promise<boolean> {
    if (this.paused || this.stopped) return false;
    const { taskStore, role } = this.deps;
    // 1. peek：只读获取候选（不锁定）
    const candidates = await taskStore.candidates(role.id);
    if (candidates.length === 0) return false;

    // 2. claim（claim 即承诺）：机械认领全部候选；单条认领为空（竞态/不可认领）不中断
    const claimed: Task[] = [];
    for (const task of candidates) {
      const got = await taskStore.claimTopN(role.id, [task.id]);
      if (got.length > 0) claimed.push(got[0]);
    }

    // 3. 正交化后零认领 = 自己队列空/全不可认领（坏任务）——直接 return 下一轮；
    //    不再 reject assessed-as-unfit（任务只属于自己，放回池无意义）
    if (claimed.length === 0) return false;

    // 4. 执行已认领任务；认领竞态丢失者跳过——竞态为正常，不 reject
    for (const task of claimed) {
      this.bus.emit("task.claim", { taskId: task.id, role: role.id, tags: task.tags });
      await this.execute(task);
    }
    return true;
  }

  /** terminal reject 统一出口（Origin 升级链事件源——task.rejected 活动事件供 trigger 消费） */
  private async rejectTerminal(task: Task, reason: string, chain: { chainDepth: number; triggerId?: string }, metricReason?: string): Promise<void> {
    const { role, taskStore } = this.deps;
    await taskStore.reject(role.id, task.id, reason, { terminal: true });
    this.deps.onActivity?.({ kind: "task.rejected", taskId: task.id, role: role.id, ok: false, detail: reason.slice(0, 120), ...chain });
    this.deps.onTaskMetric?.({ type: "status", status: "rejected" });
    this.deps.onTaskMetric?.({ type: "reject-reason", reason: metricReason ?? classifyReason(reason) });
  }

  private async execute(task: Task): Promise<void> {
    const { kernel, role, taskStore, workspaceMgr } = this.deps;
    const taskLogger = this.deps.logger?.child("taskloop", { taskId: task.id, role: role.id });
    const ws = await workspaceMgr.allocate(task.id);
    const execStart = Date.now();
    this.bus.emit("task.execute.start", { taskId: task.id, role: role.id, tags: task.tags });
    // trigger 链信息（payload.triggeredBy——防链式爆炸的链深/自触发追踪）
    const trig = (task.payload as { triggeredBy?: { depth?: number; triggerId?: string } } | undefined)?.triggeredBy;
    const chain = { chainDepth: Number(trig?.depth ?? 0), ...(trig?.triggerId ? { triggerId: trig.triggerId } : {}) };
    this.deps.onActivity?.({ kind: "task.claim", taskId: task.id, role: role.id, detail: task.title.slice(0, 100), ...chain });
    kernel.reset();                          // 任务级状态隔离
    try {
      // 任务池纯化（2026-08-10 D1）：任务池只面向自然语言——agent 循环为唯一执行路径。
      // （混合池是调试期临时形态；直连 kernel 的 TS 操作走 /kernel/exec 通道，不占任务池）
      // 降级链：PTH_AGENT_MODE=off 或无 agentCaps → 一次性转译（translateTask）；无 llm → terminal reject。
      const agentMode = process.env.PTH_AGENT_MODE !== "off";
      let code: string | null = null;
      let agentResult: { value: unknown; summary?: string; steps: number } | null = null;
      if (agentMode && this.deps.llm && this.deps.agentCaps) {
          // 任务工作区 = 正式工作区（workspaceMgr.allocate 的 ws.dir——archive 归档同一目录——
          // fs.task 白名单含 /tasks/ ✓——agent 产物随归档持久化——不丢）
          const taskWorkspace: string | undefined = ws?.dir;
          // 运行过程保留（2026-08-09）：轨迹事件收集 → 任务结束写 transcript（结构化审计/复现）
          const traceEvents: import("./agent-loop.js").AgentTraceEvent[] = [
            { type: "llm-call", step: 0, contentPreview: task.text.slice(0, 500) },  // 任务程序（起点）
          ];
          (this as unknown as { lastTraceEvents?: unknown[] }).lastTraceEvents = traceEvents;  // refine 任务 3 输入
          // 随身缓存（ASP——任务级行李）：元空间级状态——agent-loop 元工具与 ts vm 注入同源
          const { CacheStore } = await import("./cache-store.js");
          const cacheStore = new CacheStore();
          (kernel.ts as { injectCapability?: (n: string, v: unknown) => void }).injectCapability?.("cache", {
            get: (k: string) => cacheStore.get(k),
            keys: () => cacheStore.keys(),
            load: (k: string, c: string) => cacheStore.load(k, String(c), "ts-program"),
            cancel: (k: string) => cacheStore.cancel(k),
            index: () => cacheStore.index(),
          });
          const r = await runAgentTask({
            llm: this.deps.llm, kernel, caps: this.deps.agentCaps,
            task: { title: task.title, text: task.text },
            taskWorkspace,
            role,
            asp: process.env.PTH_ASP_MODE === "on",   // ASP 过渡期旗标（动作空间协议——空间状态机）
            sessionRef: (kernel as unknown as { sessionRef?: { current: { currentSpace: string } | null } }).sessionRef,
            cache: cacheStore,
            onStep: (s) => taskLogger?.info(`agent step=${s.n} tool=${s.tool} ok=${s.ok}${s.args ? ` args=${s.args}` : ""}`, { durationMs: s.durationMs }),
            logger: (m) => taskLogger?.info(m),
            onTrace: (e) => {
              traceEvents.push(e);
              // 活动事件流（实时——console --follow）：llm step（token 用量）/工具调用/完成
              if (e.type === "llm-call") this.deps.onActivity?.({ kind: "agent.step", taskId: task.id, role: role.id, step: e.step, usage: e.usage, detail: `LLM 生成（${(e.toolCalls ?? []).map((t) => t.name).join(",") || "思考"}）` });
              else if (e.type === "tool-result") this.deps.onActivity?.({ kind: "agent.tool", taskId: task.id, role: role.id, step: e.step, tool: e.tool, ok: e.ok, detail: e.resultPreview?.slice(0, 80) });
              else if (e.type === "finish") this.deps.onActivity?.({ kind: e.ok ? "task.done" : "task.failed", taskId: task.id, role: role.id, step: e.steps, ok: e.ok, detail: (e.error ?? e.valuePreview ?? "").slice(0, 100), ...chain });
            },
          });
          // 完成后持久化轨迹（transcript——task_id 关联）
          try {
            await this.deps.transcripts?.create({
              taskId: task.id,
              agentId: role.id,
              body: traceEvents,
              summary: r.ok ? (r.value !== undefined && r.value !== null ? JSON.stringify(r.value).slice(0, 200) : (r.summary ?? "")?.slice(0, 200)) : (r.error ?? "").slice(0, 200),
            });
          } catch (e) {
            taskLogger?.warn?.(`[transcript] agent 轨迹写入失败: ${(e as Error).message}`);
          }
          taskLogger?.info("agent task finished", { ok: r.ok, steps: r.steps });
          if (!r.ok) {
            await this.rejectTerminal(task, r.error, chain);
            taskLogger?.error(r.error);
            return;
          }
          // 完成标准强制（done 引导的系统级保障——2026-08-09）：agent 结束但无产物
          // （value null 且无 warning）→ 不符合完成标准——reject（不 completed 空结果）
          if (r.value === undefined || r.value === null) {
            const reason = r.warning
              ? `agent-${r.warning}`   // maxSteps/重复终止——warning 说明
              : "agent-no-output: agent 完成但未产出结果（done 未带 result）";
            await this.rejectTerminal(task, reason, chain);
            taskLogger?.error(reason, { steps: r.steps });
            return;
          }
          agentResult = { value: r.value, summary: r.summary, steps: r.steps };
      } else if (this.deps.llm) {
        // 降级通道（agent-off / 无 caps）：NL→TS 一次性转译后直执行
        const t = await translateTask({ llm: this.deps.llm }, { title: task.title, text: task.text });
        if (!t.ok) {
          await this.rejectTerminal(task, t.error, chain, "nl-translate-failed");
          taskLogger?.error(t.error);
          return;
        }
        code = t.code;
        taskLogger?.info("nl task translated", { codeLen: code.length });
      } else {
        // 无 llm：纯化后任务池无直执行路径——terminal reject（调试执行走 /kernel/exec）
        const reason = "no-llm: 任务池为自然语言池（agent/translate 均需 LLM）——直连执行请走 /kernel/exec 通道";
        await this.rejectTerminal(task, reason, chain, "no-llm");
        taskLogger?.error(reason);
        return;
      }
      const result = agentResult
        ? { ok: true, value: agentResult.value, stdout: agentResult.summary ?? "", stderr: "", durationMs: Date.now() - execStart, language: "agent" }
        : await kernel.ts.execute(code!, { cwd: ws.dir });
      const execMs = Date.now() - execStart;
      // 性能计量（SPEC L1）：TS 主执行计入 kernel exec（python/bash 由 metered 包装计）
      this.deps.onTaskMetric?.({ type: "exec", language: "ts", durationMs: execMs, ok: result.ok });
      if (!result.ok) {
        // 执行失败（语法/运行时错误——interpreter 返回 ok:false 不抛）：按 reject 处理，
        // 不得标记 completed（试运行发现：SyntaxError 任务被 submit 为 completed，语义错误）。
        await this.rejectTerminal(task, `execution-failed: ${result.error?.message ?? "unknown"}`, chain);
        await this.archive(task, ws, result);
        taskLogger?.error(`task rejected: ${result.error?.message ?? "unknown"}`, { durationMs: execMs });
        this.bus.emit("task.reject", { taskId: task.id, role: role.id, reason: result.error?.message ?? "unknown", durationMs: execMs });
        // 性能计量（SPEC L2）：阶段耗时
        this.deps.onTaskMetric?.({ type: "stage", stage: "execute", durationMs: execMs });
        return;
      }
      this.bus.emit("task.execute.end", { taskId: task.id, role: role.id, ok: true, durationMs: Date.now() - execStart });
      await taskStore.submit(role.id, task.id, { ref: result });
      this.bus.emit("task.submit", { taskId: task.id, role: role.id });
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
            // 任务 3（分化分析）输入：执行轨迹 + 角色（traceEvents 在 agent 分支收集——fast-path 为空）
            const traceForRefine = (this as unknown as { lastTraceEvents?: unknown[] }).lastTraceEvents;
            void this.deps.refiner.refine({
              task, snapshot: snap,
              trace: Array.isArray(traceForRefine) ? traceForRefine as never : undefined,
              role: role.id,
            }).catch((e) => {
              // 降级：refine 失败仅记日志，任务已 completed 不受影响（草案 P6）
              taskLogger?.error(`refine failed: ${(e as Error).message}`);
            });
          } catch (e) {
            taskLogger?.error(`refine snapshot failed: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      await this.rejectTerminal(task, `execution-crashed: ${(e as Error).message}`, chain);
      taskLogger?.error(`task crashed: ${(e as Error).message}`);
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
