import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";
import type { Task, TaskStore } from "@away_from/pth-kernel-storage";
import type { WorkerRole } from "@away_from/pth-kernel-execution";
import type { TaskWorkspaceManager } from "@away_from/pth-kernel-execution";
import type { TaskOutcome, TaskRepository, TenantScope, TaskDispatchContext } from "@away_from/pth-contracts";
import { TaskDispatcher } from "../tasking/index.js";
import { TaskOutcomeCommitter } from "../tasking/index.js";
import { BoundedBackgroundQueue } from "../tasking/index.js";
import { AgentTaskRunner } from "../runner/index.js";
import { createAuditObserver } from "../runner/index.js";
import { createTranscriptObserver } from "../runner/index.js";
import { createActivityObserver } from "../runner/index.js";
import { createMetricsObserver } from "../runner/index.js";
import { createNotifierObserver } from "../runner/index.js";
import { buildRefineSideEffects } from "../runner/index.js";
import { createOptimizerObserver } from "../runner/index.js";
import { buildScorecard, computeTimeReuse } from "@away_from/pth-kernel-execution";
import { translateTask } from "@away_from/pth-kernel-execution";
import { runPtcProgram } from "@away_from/pth-kernel-interpreter";
import { runAgentTask } from "@away_from/pth-kernel-execution";
import { getEventBus } from "@away_from/pth-kernel-interpreter";
import { publishDebugCaseTask } from "@away_from/pth-kernel-interpreter";
import { notifyTaskDone, classifyReason } from "./task-loop-helpers.js";
import { readWorkItemDomainBinding, readWorkItemDomains, type ObserverFailureRecord } from "../tasking/index.js";
import type { TaskLoopDeps } from "./task-loop-types.js";
export type { TaskLoopDeps } from "./task-loop-types.js";
import { pthConfig } from "@away_from/pth-config";

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

  /** N28 T2：有 replica 时给活动/审计事件补 workerId；无 replica 时返回空对象（旧形状逐字节不变）。 */
  private workerStamp(): { workerId?: string } {
    return this.deps.replica ? { workerId: this.deps.replica.ref.workerId } : {};
  }

  /** W8 P1/P2：任务身份盖章——tasks.delegate/await/resume 的调用者上下文（每任务执行前由本循环设置） */
  private stampTaskDispatchContext(task: Task): void {
    const kernel = this.deps.kernel as unknown as {
      setTaskDispatchContext?: (ctx: TaskDispatchContext | null) => void;
    };
    const payload = task.payload as
      | { delivery?: TaskDispatchContext["delivery"]; dispatchWait?: TaskDispatchContext["dispatchWait"]; childResult?: TaskDispatchContext["childResult"]; childQuestion?: TaskDispatchContext["childQuestion"] }
      | undefined;
    // F3：domains/domainBinding 复用 task-work-item-reader（与 claim/query 同一解析口径），
    // 不再从 payload 手工解析。
    const domains = readWorkItemDomains(task.payload);
    const domainBinding = readWorkItemDomainBinding(task.payload, domains);
    kernel.setTaskDispatchContext?.({
      taskId: task.id,
      roleId: this.deps.role.id,
      tenantId: task.tenantId ?? "default",
      ...(this.deps.replica ? { worker: this.deps.replica.ref } : {}),
      delivery: payload?.delivery ?? null,
      domains,
      ...(domainBinding ? { domainBinding } : {}),
      dispatchWait: payload?.dispatchWait,
      childResult: payload?.childResult,
      childQuestion: payload?.childQuestion,
    });
  }

  async runOnce(): Promise<boolean> {
    if (this.paused || this.stopped) return false;
    // N28 T2：replica 存在时采用严格 per-candidate cycle——先查副本状态，busy/stopped 不认领。
    if (this.deps.replica && this.deps.replica.snapshot().state !== "idle") return false;
    // F5 实现点：每轮 claim 前 kick 一次 durable side-effect drain。
    // 不 await——drainer 的慢 handler（refine LLM）不能在 claim 路径上阻塞；
    // 可靠兜底由 drainer 的 unref timer 承担，drainOnce 内部并发串行防重复领取。
    try {
      this.deps.drainSideEffects?.();
    } catch {
      // drain 触发失败不阻断 claim（drainer timer 兜底）
    }
    const { taskStore, role } = this.deps;
    // 1. peek：只读获取候选（不锁定）
    const candidates = await taskStore.candidates(role.id);
    if (candidates.length === 0) return false;

    // P1-6：注入 repository → tasking dispatcher 路径（claim→run→commit）；缺省 legacy 兼容路径。
    if (this.deps.repository) return this.runOnceDispatched(candidates);

    // 2. claim（claim 即承诺）：机械认领全部候选；单条认领为空（竞态/不可认领）不中断。
    // N28 T2：replica 存在时不得预领 batch——每次 runOnce 只处理一个候选（per-candidate cycle）。
    const toClaim = this.deps.replica ? candidates.slice(0, 1) : candidates;
    const claimed: Task[] = [];
    for (const task of toClaim) {
      const got = await taskStore.claimTopN(role.id, [task.id]);
      if (got.length > 0) claimed.push(got[0]);
    }

    // 3. 正交化后零认领 = 自己队列空/全不可认领（坏任务）——直接 return 下一轮；
    //    不再 reject assessed-as-unfit（任务只属于自己，放回池无意义）
    if (claimed.length === 0) return false;

    // 4. 执行已认领任务；认领竞态丢失者跳过——竞态为正常，不 reject
    for (const task of claimed) {
      // N28 T2：每个候选执行前再查一次状态（busy remove 后不得在同轮预领/执行第二候选）。
      if (this.deps.replica && this.deps.replica.snapshot().state !== "idle") break;
      this.deps.replica?.startTask(task.id);
      this.bus.emit("task.claim", { taskId: task.id, role: role.id, tags: task.tags, ...this.workerStamp() });
      try {
        await this.execute(task);
      } finally {
        this.deps.replica?.finishTask(task.id);
      }
    }
    return true;
  }


  /** P1-6：tasking dispatcher 路径（repository 注入）——peek 后逐候选 claim→run→commit */
  private async runOnceDispatched(candidates: Task[]): Promise<boolean> {
    const { role, repository, workspaceMgr, taskStore } = this.deps;
    let did = false;
    for (const task of candidates) {
      if (this.paused || this.stopped) break;
      // N28 T2：per-candidate cycle——每候选执行前查状态；busy/stopped 不认领下一候选。
      if (this.deps.replica && this.deps.replica.snapshot().state !== "idle") break;
      this.deps.replica?.startTask(task.id);
      try {
      const ws = await workspaceMgr.allocate(task.id, task.tenantId ?? "default");
      this.stampTaskDispatchContext(task);
      const execStart = Date.now();
      const trig = (task.payload as { triggeredBy?: { depth?: number; triggerId?: string } } | undefined)?.triggeredBy;
      const chain = { chainDepth: Number(trig?.depth ?? 0), ...(trig?.triggerId ? { triggerId: trig.triggerId } : {}) };
      const traceEvents: import("@away_from/pth-kernel-execution").AgentTraceEvent[] = [];
      const taskLogger = this.deps.logger?.child("taskloop", { taskId: task.id, role: role.id });
      const runner = new AgentTaskRunner({
        kernel: this.deps.kernel,
        role,
        workspace: { taskId: task.id, tenant: ws.tenant, dir: ws.dir },
        llm: this.deps.llm,
        caps: this.deps.agentCaps,
        toolRegStore: this.deps.toolRegStore,   // N14 P2：注册表快照读取口
        toolRegRunChild: this.deps.toolRegRunChild,   // N14 P2：agent 态执行缝
        knowledgeContextProvider: this.deps.knowledgeContextProvider,   // K3：任务知识上下文（claim 后一次性快照）
        replica: this.deps.replica?.ref,
        verifiedReadScopeFactory: this.deps.verifiedReadScopeFactory,
        memoryDirectory: this.deps.memoryDirectory,
        cognitiveWorkingSetProvider: this.deps.cognitiveWorkingSetProvider,
        cognitiveResponsibilityMode: this.deps.cognitiveResponsibilityMode,
        authorizedReads: this.deps.authorizedReads,
        professionalRegistry: this.deps.professionalRuntimeRegistry,
        professionalArtifacts: this.deps.professionalArtifacts,
        professionalGrantService: this.deps.professionalGrantService,
        professionalGrantTtlMs: this.deps.professionalGrantTtlMs,
        commandGateway: this.deps.commandGateway,
        extraTools: this.deps.extraTools,
        onStep: (s) => taskLogger?.info(`agent step=${s.n} tool=${s.tool} ok=${s.ok}${s.args ? ` args=${s.args}` : ""}`, { durationMs: s.durationMs }),
        logger: (m) => taskLogger?.info(m),
        onTrace: (e) => {
          traceEvents.push(e);
          if (e.type === "llm-call") this.deps.onActivity?.({ kind: "agent.step", taskId: task.id, role: role.id, step: e.step, usage: e.usage, detail: `LLM 生成（${(e.toolCalls ?? []).map((t) => t.name).join(",") || "思考"}）`, ...this.workerStamp() });
          else if (e.type === "tool-result") this.deps.onActivity?.({ kind: "agent.tool", taskId: task.id, role: role.id, step: e.step, tool: e.tool, ok: e.ok, detail: e.resultPreview?.slice(0, 80), ...this.workerStamp() });
          else if (e.type === "finish") this.deps.onActivity?.({ kind: e.ok ? "task.done" : "task.failed", taskId: task.id, role: role.id, step: e.steps, ok: e.ok, detail: (e.error ?? e.valuePreview ?? "").slice(0, 100), ...this.workerStamp(), ...chain });
        },
      });
      this.bus.emit("task.execute.start", { taskId: task.id, role: role.id, tags: task.tags, ...this.workerStamp() });
      const slowQueue = new BoundedBackgroundQueue({ maxConcurrency: 2, logger: (m) => taskLogger?.warn?.(m) });
      // F5 audit binding（6.7）：先捕获 audit store 对象，再 `(ev) => audit.write(ev)`——
      // 不先解引用方法，否则 PgAuditStore.write 内的 this.pool 丢失绑定。
      const audit = (this.deps.kernel.dataWorld as unknown as { audit?: { write?(ev: { eventType: string; actor?: string; taskId?: string; tenantId?: string; payload?: unknown }): Promise<void> } } | undefined)?.audit;
      // 同样以对象方法调用 transcripts（obj.method 形态，this 绑定安全）。
      const transcripts = this.deps.transcripts;
      const sideEffectOutbox = this.deps.sideEffectOutbox;
      const recordObserverFailure = (failure: ObserverFailureRecord): Promise<void> | void => {
        if (!sideEffectOutbox) return;
        const key = `observer-failure:${failure.tenantId}:${failure.taskId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        return sideEffectOutbox.enqueue({
          key,
          tenantId: failure.tenantId,
          kind: "observer-failure",
          payload: { ...failure, at: new Date().toISOString() },
        }).catch((e) => {
          this.deps.logger?.child?.("taskloop", { taskId: failure.taskId })?.warn?.(
            `observer failure enqueue failed [${failure.observerName}]: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      };
      const observers: Array<import("../tasking/index.js").TaskOutcomeObserver> = [
        ...(audit?.write
          ? [{
              name: "audit-observer",
              stage: "audit",
              durable: true,
              observe: createAuditObserver({ write: (ev) => audit.write!(ev) }),
            }]
          : []),
        ...(transcripts
          ? [{
              name: "transcript-observer",
              stage: "transcript",
              durable: true,
              observe: createTranscriptObserver({ create: (input) => transcripts.create(input as never) }),
            }]
          : []),
        {
          name: "activity-observer",
          stage: "activity",
          observe: createActivityObserver({ emit: (e) => this.deps.onActivity?.({ ...e, role: role.id, taskId: task.id }) }),
        },
        {
          name: "metrics-observer",
          stage: "metrics",
          observe: createMetricsObserver({ metric: (m) => this.deps.onTaskMetric?.(m), classifyReason }),
        },
        { name: "notifier-observer", stage: "notify", observe: createNotifierObserver() },
        ...(this.deps.optimizer
          ? [{
              name: "optimizer-observer",
              stage: "optimizer",
              observe: createOptimizerObserver({
                queue: slowQueue,
                optimizer: this.deps.optimizer,
                buildScorecard: (trace) => buildScorecard(trace as never),
                computeTimeReuse: (subtasks) => computeTimeReuse(subtasks),
                roleId: role.id,
                logger: (m) => taskLogger?.error(m),
              }),
            }]
          : []),
        {
          name: "after-committed",
          stage: "archive",
          observe: (evt: { outcome: TaskOutcome }) => this.afterCommittedNew(task, ws, evt.outcome, chain, execStart),
        },
      ];
      const dispatcher = new TaskDispatcher({
        repository: repository!,
        committer: new TaskOutcomeCommitter(repository!),
        runner,
        observers,
        onObserverFailure: recordObserverFailure,
        onSuspension: this.deps.onSuspension,
        // R4/P0-4：refine 的持久化 enqueue 作为 side-effect 随 commit 同事务提交。
        buildSideEffects: this.deps.refiner && sideEffectOutbox
          ? (evt) => buildRefineSideEffects({ kernel: this.deps.kernel, roleId: role.id }, evt)
          : undefined,
        context: { task, ws, chain, execStart, traceEvents },
        logger: (m) => taskLogger?.warn?.(m),
      });
      const scope: TenantScope = {
        tenantId: task.tenantId ?? "default",
        principalId: this.deps.replica ? `worker:${this.deps.replica.ref.workerId}` : role.id,
        roles: [role.id],
        traceId: `task:${task.id}`,
      };
      const res = await dispatcher.dispatchOnce(scope, role.id, [task.id]);
      if (res.claimed > 0) {
        this.bus.emit("task.claim", { taskId: task.id, role: role.id, tags: task.tags, ...this.workerStamp() });
        this.deps.onActivity?.({ kind: "task.claim", taskId: task.id, role: role.id, detail: task.title.slice(0, 100), ...this.workerStamp(), ...chain });
      }
      did = did || res.ran > 0;
      } finally {
        this.deps.replica?.finishTask(task.id);
      }
    }
    return did;
  }

  /** P1-6/P1-7：committed 后剩余副作用（终态已由 CAS 落库；audit/activity/metrics/notify/refine/optimizer 由 observers fan-out） */
  private async afterCommittedNew(
    task: Task,
    ws: { dir: string; tenant: string },
    outcome: TaskOutcome,
    _chain: { chainDepth: number; triggerId?: string },
    execStart: number,
  ): Promise<void> {
    const { role } = this.deps;
    const taskLogger = this.deps.logger?.child("taskloop", { taskId: task.id, role: role.id });
    const execMs = Date.now() - execStart;

    if (outcome.status === "completed") {
      this.bus.emit("task.execute.end", { taskId: task.id, role: role.id, ok: true, durationMs: execMs });
      this.bus.emit("task.submit", { taskId: task.id, role: role.id });
      const resultLike = {
        value: (outcome.result as { value?: unknown } | undefined)?.value ?? outcome.result,
        stdout: (outcome.result as { stdout?: string } | undefined)?.stdout ?? "",
        summary: (outcome.result as { summary?: string } | undefined)?.summary ?? "",
      };
      await this.invokeArchive(task, ws, resultLike);
      await this.maybeDispatchDebugCaseWriter(task, resultLike);
      taskLogger?.info("task completed", { durationMs: execMs });
      return;
    }

    this.bus.emit("task.reject", {
      taskId: task.id,
      role: role.id,
      reason: outcome.error?.message ?? "unknown",
      durationMs: execMs,
    });
  }

  /** 归档钩子注入（BatchTaskLoop 组合）或 protected 默认实现 */
  private async invokeArchive(task: Task, ws: { dir: string; tenant: string }, result: unknown): Promise<void> {
    if (this.deps.archiveFn) return this.deps.archiveFn(task, ws, result);
    await this.archive(task, ws, result);
  }

  /** terminal reject 统一出口（Origin 升级链事件源——task.rejected 活动事件供 trigger 消费） */
  private async rejectTerminal(task: Task, reason: string, chain: { chainDepth: number; triggerId?: string }, metricReason?: string): Promise<void> {
    const { role, taskStore } = this.deps;
    const affected = await taskStore.reject(role.id, task.id, reason, { terminal: true });
    if (affected === 0) {
      // 审计 H5：认领已不属于本 worker（回收重领后执行失败）——告警但不覆盖他人认领
      this.deps.logger?.child?.("taskloop", { taskId: task.id, role: role.id })?.warn?.(
        `reject 0 rows（认领已被回收重领？task=${task.id}）——不覆盖他人认领`,
      );
    }
    // 审计两平面接线（2026-08-14 A2 Phase 3）：任务终态写 PG audit_log——
    // 会话面事件（tool_call/self_modify）留 Redis Stream；审计失败不阻断任务流
    const audit = (this.deps.kernel.dataWorld as unknown as { audit?: { write?: (ev: { eventType: string; actor?: string; taskId?: string; workerId?: string; payload?: unknown }) => Promise<void> } } | undefined)?.audit;
    if (audit?.write) {
      try { await audit.write({ eventType: "task_rejected", actor: this.deps.replica ? `worker:${this.deps.replica.ref.workerId}` : role.id, taskId: task.id, ...this.workerStamp(), payload: { reason: reason.slice(0, 300), ...(this.deps.replica ? { roleId: role.id } : {}) } }); } catch { /* 审计容错 */ }
    }
    this.deps.onActivity?.({ kind: "task.rejected", taskId: task.id, role: role.id, ok: false, detail: reason.slice(0, 120), ...this.workerStamp(), ...chain });
    this.deps.onTaskMetric?.({ type: "status", status: "rejected" });
    this.deps.onTaskMetric?.({ type: "reject-reason", reason: metricReason ?? classifyReason(reason) });
  }

  /** D5（2026-08-15）：软终止/警告闭合的任务回收——非终态 reject 回 pending（保留 claims_count
   *  兜底 MAX_CLAIMS；recoverStaleClaims 与路由不变）。转派/重试由下轮 claim 完成。 */
  private async requeue(task: Task, reason: string, chain: { chainDepth: number; triggerId?: string }): Promise<void> {
    const { role, taskStore } = this.deps;
    const affected = await taskStore.reject(role.id, task.id, reason, { terminal: false });
    if (affected === 0) {
      this.deps.logger?.child?.("taskloop", { taskId: task.id, role: role.id })?.warn?.(
        `requeue 0 rows（认领已被回收重领？task=${task.id}）——不覆盖他人认领`,
      );
    }
    const audit = (this.deps.kernel.dataWorld as unknown as { audit?: { write?: (ev: { eventType: string; actor?: string; taskId?: string; workerId?: string; payload?: unknown }) => Promise<void> } } | undefined)?.audit;
    if (audit?.write) {
      try { await audit.write({ eventType: "task_requeued", actor: this.deps.replica ? `worker:${this.deps.replica.ref.workerId}` : role.id, taskId: task.id, ...this.workerStamp(), payload: { reason: reason.slice(0, 300), ...(this.deps.replica ? { roleId: role.id } : {}) } }); } catch { /* 审计容错 */ }
    }
    this.deps.onActivity?.({ kind: "task.requeued", taskId: task.id, role: role.id, ok: false, detail: reason.slice(0, 120), ...this.workerStamp(), ...chain });
    this.deps.onTaskMetric?.({ type: "status", status: "requeued" });
    this.deps.onTaskMetric?.({ type: "reject-reason", reason: "soft-terminated" });
  }

  /** P3.6（2026-08-15）：developer 修复任务完成后自动派发 debug-case-writer——
   *  自修正闭环验证环节（最小复现 + 回归测试 + 边界用例）。payload.debugCases="off" 可关。 */
  private async maybeDispatchDebugCaseWriter(task: Task, result: { value?: unknown; stdout?: string }): Promise<void> {
    const { role, taskStore } = this.deps;
    if (role.id !== "developer") return;
    if (!Array.isArray(task.tags) || !task.tags.includes("fix")) return;
    const payload = (task.payload ?? {}) as { debugCases?: string };
    if (payload.debugCases === "off") return;
    try {
      const fixSummary = result.value !== undefined
        ? JSON.stringify(result.value).slice(0, 10_000)
        : (result.stdout ?? "").slice(0, 10_000);
      const child = await publishDebugCaseTask(taskStore, {
        bugReport: `任务 ${task.id}（标题：${task.title}）\n${task.text}`,
        fixSummary,
        parentTaskId: task.id,
        source: "developer-fix-completed",
      });
      this.deps.onActivity?.({ kind: "debug-case.dispatched", taskId: child.id, role: "debug-case-writer", ok: true, detail: `parent=${task.id}` });
      this.deps.logger?.child?.("taskloop", { taskId: task.id, role: role.id })?.info?.(`debug-case-writer 已派发（parent=${task.id} → ${child.id}）`);
    } catch (e) {
      // 派发失败不阻断父任务已完成（自修正闭环是增强环节——失败留告警）
      this.deps.logger?.child?.("taskloop", { taskId: task.id, role: role.id })?.warn?.(`debug-case-writer 派发失败: ${(e as Error).message}`);
    }
  }

  private async execute(task: Task): Promise<void> {
    const { kernel, role, taskStore, workspaceMgr } = this.deps;
    const taskLogger = this.deps.logger?.child("taskloop", { taskId: task.id, role: role.id });
    const ws = await workspaceMgr.allocate(task.id, (task as { tenantId?: string }).tenantId ?? "default");
    const execStart = Date.now();
    this.bus.emit("task.execute.start", { taskId: task.id, role: role.id, tags: task.tags, ...this.workerStamp() });
    // trigger 链信息（payload.triggeredBy——防链式爆炸的链深/自触发追踪）
    const trig = (task.payload as { triggeredBy?: { depth?: number; triggerId?: string } } | undefined)?.triggeredBy;
    const chain = { chainDepth: Number(trig?.depth ?? 0), ...(trig?.triggerId ? { triggerId: trig.triggerId } : {}) };
    this.deps.onActivity?.({ kind: "task.claim", taskId: task.id, role: role.id, detail: task.title.slice(0, 100), ...this.workerStamp(), ...chain });
    kernel.reset();                          // 任务级状态隔离
    this.stampTaskDispatchContext(task);
    try {
      // 任务池纯化（2026-08-10 D1）：任务池只面向自然语言——agent 循环为唯一执行路径。
      // （混合池是调试期临时形态；直连 kernel 的 TS 操作走 /kernel/exec 通道，不占任务池）
      // 降级链：PTH_AGENT_MODE=off 或无 agentCaps → 一次性转译（translateTask）；无 llm → terminal reject。
      const agentMode = pthConfig().str("PTH_AGENT_MODE") !== "off";
      let code: string | null = null;
      let agentResult: { value: unknown; summary?: string; steps: number } | null = null;
      let cacheStore: import("@away_from/pth-kernel-execution").CacheStore | undefined;   // 任务完成点取利用率（N3）
      if (agentMode && this.deps.llm && this.deps.agentCaps) {
          // 任务工作区 = 正式工作区（workspaceMgr.allocate 的 ws.dir——archive 归档同一目录——
          // fs.task 白名单含 /tasks/ ✓——agent 产物随归档持久化——不丢）
          const taskWorkspace: string | undefined = ws?.dir;
          // 运行过程保留（2026-08-09）：轨迹事件收集 → 任务结束写 transcript（结构化审计/复现）
          const traceEvents: import("@away_from/pth-kernel-execution").AgentTraceEvent[] = [
            { type: "llm-call", step: 0, contentPreview: task.text.slice(0, 500) },  // 任务程序（起点）
          ];
          (this as unknown as { lastTraceEvents?: unknown[] }).lastTraceEvents = traceEvents;  // refine 任务 3 输入
          // 随身缓存（ASP——任务级行李）：元空间级状态——agent-loop 元工具与 ts vm 注入同源
          const { CacheStore } = await import("@away_from/pth-kernel-execution");
          cacheStore = new CacheStore();
          const cs = cacheStore;   // 闭包内非空收窄（TS 控制流不穿透闭包）
          // 任务级能力装配（2026-08-14 A1 Phase 3 条目 12）：cache 注入收敛进 runner——
          // 不再直调 injectCapability；agent-loop 透传，每 ts 程序执行前统一装配（与越界预检同一机制）
          const capabilityInject: Record<string, unknown> = {
            cache: {
              get: (k: string) => cs.get(k),
              keys: () => cs.keys(),
              load: (k: string, c: string) => cs.load(k, String(c), "ts-program"),
              cancel: (k: string) => cs.cancel(k),
              index: () => cs.index(),
              utilization: () => cs.utilization(),
            },
          };
          // sandbox grant 动态绑定：本任务 taskId/tenantId 下发给 kernel 工厂（worker 级兜底 → 任务级）
          (kernel as { setExecutionGrantContext?(ctx: { taskId: string; tenantId: string; principalId?: string }): void })
            .setExecutionGrantContext?.({
              taskId: task.id,
              tenantId: task.tenantId ?? "system",
              principalId: this.deps.replica ? `worker:${this.deps.replica.ref.workerId}` : role.id,
            });
          // N14 P2：任务开始冻结 tool-reg 快照（T3 防线）+ agent 态执行缝透传
          const toolRegistry = this.deps.toolRegStore
            ? await (await import("@away_from/pth-kernel-interpreter")).loadToolRegSnapshot(this.deps.toolRegStore, { tenantId: task.tenantId ?? "default" })
            : undefined;
          const r = await runAgentTask({
            llm: this.deps.llm, kernel, caps: this.deps.agentCaps,
            task: { title: task.title, text: task.text },
            taskWorkspace,
            toolstore: (kernel as unknown as { toolstore?: import("@away_from/pth-kernel-interpreter").Toolstore }).toolstore,
            role,
            asp: pthConfig().str("PTH_ASP_MODE") === "on",   // ASP 状态机（compose 默认 on——全件落地）
            sessionRef: (kernel as unknown as { sessionRef?: { current: { currentSpace: string } | null } }).sessionRef,
            cache: cs,
            capabilityInject,
            toolRegistry,
            toolRegExec: this.deps.toolRegRunChild
              ? { runChild: this.deps.toolRegRunChild, caller: { taskId: task.id, roleId: role.id, tenantId: task.tenantId ?? "default", delivery: null } }
              : undefined,
            onStep: (s) => taskLogger?.info(`agent step=${s.n} tool=${s.tool} ok=${s.ok}${s.args ? ` args=${s.args}` : ""}`, { durationMs: s.durationMs }),
            logger: (m) => taskLogger?.info(m),
            onTrace: (e) => {
              traceEvents.push(e);
              // 活动事件流（实时——console --follow）：llm step（token 用量）/工具调用/完成
              if (e.type === "llm-call") this.deps.onActivity?.({ kind: "agent.step", taskId: task.id, role: role.id, step: e.step, usage: e.usage, detail: `LLM 生成（${(e.toolCalls ?? []).map((t) => t.name).join(",") || "思考"}）`, ...this.workerStamp() });
              else if (e.type === "tool-result") this.deps.onActivity?.({ kind: "agent.tool", taskId: task.id, role: role.id, step: e.step, tool: e.tool, ok: e.ok, detail: e.resultPreview?.slice(0, 80), ...this.workerStamp() });
              else if (e.type === "finish") this.deps.onActivity?.({ kind: e.ok ? "task.done" : "task.failed", taskId: task.id, role: role.id, step: e.steps, ok: e.ok, detail: (e.error ?? e.valuePreview ?? "").slice(0, 100), ...this.workerStamp(), ...chain });
            },
          });
          // 完成后持久化轨迹（transcript——task_id 关联）
          try {
            await this.deps.transcripts?.create({
              taskId: task.id,
              agentId: role.id,
              body: traceEvents,
              // 压缩产物优先（CoT 总结——评估读者不碰全量轨迹）；无压缩回退 200c 预览
              summary: r.compression?.text ?? (r.ok ? (r.value !== undefined && r.value !== null ? JSON.stringify(r.value).slice(0, 200) : (r.summary ?? "")?.slice(0, 200)) : (r.error ?? "").slice(0, 200)),
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
          // 完成标准强制（done 引导的系统级保障——2026-08-09）：agent 结束但无产物。
          // D5：软终止/警告闭合（maxSteps/重复/负结果循环）→ 回池重试（claims_count 兜底）；
          // 无 warning 的空产物仍是终态 reject（agent-no-output）。
          if (r.value === undefined || r.value === null) {
            if (r.warning) {
              const reason = `soft-terminated: ${r.warning}`;
              await this.requeue(task, reason, chain);
              taskLogger?.warn(reason, { steps: r.steps });
              return;
            }
            const reason = "agent-no-output: agent 完成但未产出结果（done 未带 result）";
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
        : (await runPtcProgram({ code: code!, cwd: ws.dir, ts: kernel.ts })).raw;
      const execMs = Date.now() - execStart;
      // 性能计量（SPEC L1）：TS 主执行计入 kernel exec（python/bash 由 metered 包装计）
      this.deps.onTaskMetric?.({ type: "exec", language: "ts", durationMs: execMs, ok: result.ok });
      if (!result.ok) {
        // 执行失败（语法/运行时错误——interpreter 返回 ok:false 不抛）：按 reject 处理，
        // 不得标记 completed（试运行发现：SyntaxError 任务被 submit 为 completed，语义错误）。
        await this.rejectTerminal(task, `execution-failed: ${result.error?.message ?? "unknown"}`, chain);
        await this.invokeArchive(task, ws, result);
        taskLogger?.error(`task rejected: ${result.error?.message ?? "unknown"}`, { durationMs: execMs });
        notifyTaskDone({ taskId: task.id, role: role.id, status: "rejected", error: result.error?.message ?? "unknown" });
        this.bus.emit("task.reject", { taskId: task.id, role: role.id, reason: result.error?.message ?? "unknown", durationMs: execMs });
        // 性能计量（SPEC L2）：阶段耗时
        this.deps.onTaskMetric?.({ type: "stage", stage: "execute", durationMs: execMs });
        return;
      }
      this.bus.emit("task.execute.end", { taskId: task.id, role: role.id, ok: true, durationMs: Date.now() - execStart });
      const affected = await taskStore.submit(role.id, task.id, { ref: result });
      if (affected === 0) {
        // 审计 H5：认领已不属于本 worker（任务被回收重领）——结果静默丢失，告警审计
        taskLogger?.warn(`submit 0 rows（认领已被回收重领？task=${task.id}）——结果未落库`);
        this.deps.onActivity?.({ kind: "task.submit-conflict", taskId: task.id, role: role.id, ok: false, detail: "submit 0 rows——claim 已被回收/重领", ...this.workerStamp() });
      }
      // 审计两平面接线（2026-08-14 A2 Phase 3）：任务终态写 PG audit_log（会话面事件留 Redis Stream）
      const auditDone = (this.deps.kernel.dataWorld as unknown as { audit?: { write?: (ev: { eventType: string; actor?: string; taskId?: string; workerId?: string; payload?: unknown }) => Promise<void> } } | undefined)?.audit;
      if (auditDone?.write) {
        try { await auditDone.write({ eventType: "task_completed", actor: this.deps.replica ? `worker:${this.deps.replica.ref.workerId}` : role.id, taskId: task.id, ...this.workerStamp(), payload: { submitAffected: affected, ...(this.deps.replica ? { roleId: role.id } : {}) } }); } catch { /* 审计容错 */ }
      }
      this.bus.emit("task.submit", { taskId: task.id, role: role.id });
      await this.invokeArchive(task, ws, result);
      await this.maybeDispatchDebugCaseWriter(task, result);
      taskLogger?.info("task completed", { durationMs: execMs });
      this.deps.onTaskMetric?.({ type: "status", status: "completed" });
      // 完成通知（2026-08-13 hook 机制：PTH→PTL 推送——pth-notify 扩展收事件注入主会话）
      notifyTaskDone({ taskId: task.id, role: role.id, status: "completed", summary: (result as { summary?: string })?.summary });
      this.deps.onTaskMetric?.({ type: "stage", stage: "execute", durationMs: execMs });
      // Refine（T4）：任务完成后快照+提炼+持久化。kernel.reset 在下一任务才调用——
      // 此刻 context 仍存活，可快照。
      // 性能修复（摸底发现）：refine 的 LLM 调用（1-2s）必须在 execute 循环外异步完成——
      // 否则同角色串行任务被 refine 阻塞（submit 间隔 = 上个任务的 refine 时长）。
      // snapshot 必须同步 await（下一任务 reset 会清 context）；LLM 提炼 fire-and-forget。
      // 优化循环（2026-08-12 大项）：任务完成点收集 scorecard（agent 分支有 trace——fast-path 跳过）。
      // fire-and-forget（与 refine 同异步模式——不阻塞任务循环）；缓冲/落库失败降级记日志。
      if (this.deps.optimizer) {
        const traceForOpt = (this as unknown as { lastTraceEvents?: unknown[] }).lastTraceEvents;
        if (Array.isArray(traceForOpt) && traceForOpt.length > 0) {
          try {
            const { buildScorecard, computeTimeReuse } = await import("@away_from/pth-kernel-execution");
            const { getEventBus } = await import("@away_from/pth-kernel-interpreter");
            const sc = buildScorecard(traceForOpt as never);
            // 时间复用率（2026-08-13 监测量）：planner 产出计划扁平度——done result 解析
            const value = (result as { value?: unknown } | undefined)?.value as Record<string, unknown> | undefined;
            const subtasks = value?.["subtasks"];
            if (Array.isArray(subtasks) && subtasks.length > 0) {
              sc.timeReuse = computeTimeReuse(subtasks as Array<{ id?: string; dependsOn?: string[] }>);
            }
            // 数据缓存利用率（2026-08-13 N3——0.11.4.2：scorecard 新指标——fast-path 无缓存为空）
            if (cacheStore) sc.cacheUtilization = cacheStore.utilization();
            // 复测任务透传（2026-08-14 N6 一等化）：verifyOf → 复测聚合（受控证据——不进热点窗口/角色聚合）
            this.deps.optimizer.collect(sc, { role: role.id, taskId: task.id, tenantId: task.tenantId ?? "default", verifyOf: (task.payload as { verifyOf?: string } | undefined)?.verifyOf });
          } catch (e) {
            taskLogger?.error(`optimizer collect failed: ${(e as Error).message}`);
          }
        }
      }
      if (this.deps.refiner) {
        // Per-task refine 开关（P6 增强）：payload.refine = "off" 关闭；缺省跟随全局
        const taskRefine = ((task.payload ?? {}) as { refine?: string }).refine;
        if (taskRefine !== "off") {
          try {
            const snap = await this.deps.kernel.snapshot();
            // 任务 3（分化分析）输入：执行轨迹 + 角色（traceEvents 在 agent 分支收集——fast-path 为空）
            const traceForRefine = (this as unknown as { lastTraceEvents?: unknown[] }).lastTraceEvents;
            // F5 lineage：legacy 路径从 task payload 解析 domains/domainBinding（与 claim 同口径）。
            const domains = readWorkItemDomains(task.payload);
            const domainBinding = readWorkItemDomainBinding(task.payload, domains);
            void this.deps.refiner.refine({
              task, snapshot: snap,
              scope: { tenantId: task.tenantId ?? "default", space: "meta" },
              trace: Array.isArray(traceForRefine) ? traceForRefine as never : undefined,
              role: role.id,
              domains,
              ...(domainBinding ? { domainBinding } : {}),
              outcome: { status: "completed", result },
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
