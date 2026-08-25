/**
 * bootstrap/batch/ipc-control.ts —— P2-9 装配段：IPC 控制链 + 进程生命周期 + 心跳上报。
 *
 *  - createKernelDisposer：退出前释放全部 worker kernel（sandbox acquire 归还——防池泄漏），幂等；
 *  - installBatchIpcControl：unhandledRejection/uncaughtException 容错、SIGTERM/SIGINT/disconnect/
 *    exit 优雅退出、`process.on("message")` 控制面（pause/resume/worker 控制/role-register/worker-add/
 *    optimizer-sweep/intake-due-scan）、EventBus→主进程 kernel-event 桥；
 *  - startBatchStatusReporter：2s 心跳（feasibility 投影共享 runtime；off 保持旧形状）。
 *
 * 注意：runtime/loops/createWorker/makeSlot 在 handler 注册点之后才完成装配，
 * 全部经惰性 accessor 传入——消息到达前的 TDZ 语义与原组合根一致。
 */

import { getEventBus } from "@away_from/pth-kernel-interpreter";
import { pthConfig } from "@away_from/pth-config";
import {
  allWorkerRoles,
  isForwardableKernelEvent,
  knownRoleById,
  registerWorkerRole,
  toKernelActivityEvent,
} from "@away_from/pth-kernel-execution";
import {
  responsibilitiesForWorker,
  type MemoryDirectorySnapshot,
} from "../../execution/index.js";
import type { WorkerLoopAccess, WorkerSlot, WorkerSlotRuntime } from "../worker-slot-runtime.js";
import type {
  AuthoritativeWorkingSets,
  BatchControlState,
  BatchLogger,
  BatchLoopEntry,
  CreatedWorker,
  IntakeTrigger,
} from "./context.js";
import type { WorkerRole } from "@away_from/pth-kernel-execution";

/** W-c：在飞上下文的 IPC 传输投影（子进程侧有界化）。
 *   - 只取最后 last 条（默认 10，上限 100）；
 *   - 每条 content 截断 4000 字符；
 *   - system 消息单独放 task 级 system 字段，消息列表剔除 system；
 *   - 整体 JSON 超 PTH_WORKER_CONTEXT_MAX_CHARS 时从旧到新丢消息并标 truncated。 */
function boundWorkerContext(raw: unknown, lastRaw: number): { system?: string; messages: Array<Record<string, unknown>>; truncated?: boolean } {
  const last = Math.min(Math.max(Math.floor(lastRaw) || 10, 1), 100);
  if (!Array.isArray(raw)) return { messages: [] };
  const truncate = (v: unknown): string => {
    const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
    return s.length > 4000 ? s.slice(0, 4000) : s;
  };
  const systemMsg = (raw as Array<Record<string, unknown>>).find((m) => m?.role === "system");
  let system = systemMsg ? truncate(systemMsg.content) : undefined;
  const messages: Array<Record<string, unknown>> = (raw as Array<Record<string, unknown>>)
    .filter((m) => m?.role !== "system")
    .slice(-last)
    .map((m) => ({
      role: String(m?.role ?? "unknown"),
      content: truncate(m?.content),
      ...(typeof m?.toolCallId === "string" ? { toolCallId: m.toolCallId } : {}),
      ...(typeof m?.toolName === "string" ? { toolName: m.toolName } : {}),
      ...(m?.thinking !== undefined ? { thinking: truncate(m.thinking) } : {}),
    }));
  const maxChars = pthConfig().num("PTH_WORKER_CONTEXT_MAX_CHARS", 200_000);
  let truncated = false;
  while (messages.length > 0 && JSON.stringify({ system, messages }).length > maxChars) {
    messages.shift();
    truncated = true;
  }
  // system 单独超限时也做兜底截断（查询通道只读，绝不让超长 payload 打爆 IPC）。
  if (JSON.stringify({ system, messages }).length > maxChars && system !== undefined) {
    const keep = Math.max(maxChars - JSON.stringify({ system: "", messages }).length, 0);
    system = system.slice(0, keep);
    truncated = true;
  }
  return {
    ...(system !== undefined ? { system } : {}),
    messages,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** W-b/W-c：统一收集在飞 TaskLoop 的只读访问面（off=loops 数组；feasibility=共享 runtime slots）。 */
function liveLoopAccess(input: {
  mode: "off" | "feasibility";
  getRuntime: () => WorkerSlotRuntime;
  getLoops: () => BatchLoopEntry[];
}): WorkerLoopAccess[] {
  if (input.mode === "feasibility") return input.getRuntime().activeLoops();
  return input.getLoops().map((l) => ({
    role: l.role.id,
    getActiveTask: () => l.getActiveTask(),
    getLiveContext: () => l.getLiveContext(),
  }));
}

/** 退出前释放全部 worker kernel（sandbox acquire 归还——防池泄漏）——幂等。 */
export interface KernelDisposer {
  disposeAllKernels: () => Promise<void>;
  isDisposed: () => boolean;
}

export function createKernelDisposer(input: {
  mode: "off" | "feasibility";
  getRuntime: () => WorkerSlotRuntime;
  getLoops: () => BatchLoopEntry[];
}): KernelDisposer {
  const { mode, getRuntime, getLoops } = input;
  let disposed = false;
  const disposeAllKernels = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    if (mode === "feasibility") {
      // 共享 runtime 拥有唯一 slot/dispose 生命周期（包括 busy-remove 后置清理）。
      await getRuntime().disposeAll();
      return;
    }
    for (const l of getLoops()) {
      const k = (l as unknown as { kernel?: { dispose?: () => Promise<void> | void; abort?: () => Promise<void> } }).kernel;
      // Phase 3 条目 11：先 abort in-flight 程序（程序级制动）再 dispose 资源——DSH 对照 ③
      try { await k?.abort?.(); } catch { /* abort 容错 */ }
      try { await k?.dispose?.(); } catch { /* dispose 容错 */ }
    }
  };
  return { disposeAllKernels, isDisposed: () => disposed };
}

export interface BatchIpcControlDeps {
  mode: "off" | "feasibility";
  batchLogger: BatchLogger;
  controlState: BatchControlState;
  intakeTrigger: IntakeTrigger;
  /** N28 复核 Layer3：role 批量 remove 的最终回执聚合（全部 worker-removed 后发唯一 role removed）。 */
  pendingRoleRemovals: Map<string, Set<string>>;
  disposer: KernelDisposer;
  getRuntime: () => WorkerSlotRuntime;
  getLoops: () => BatchLoopEntry[];
  createWorker: (role: WorkerRole) => CreatedWorker;
  makeSlot: (w: CreatedWorker) => WorkerSlot;
}

export function installBatchIpcControl(deps: BatchIpcControlDeps): void {
  const { mode, batchLogger, controlState, intakeTrigger, pendingRoleRemovals, disposer } = deps;
  const { disposeAllKernels } = disposer;
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
  process.on("exit", (code) => { if (!disposer.isDisposed()) void disposeAllKernels().finally(() => exitNow(code)); });

  process.on("message", async (msg: any) => {
    if (msg?.type === "set-param" && typeof msg.key === "string") {
      // 性能自持（v0.8）：主进程 autopilot 下发调参 → batch 进程内 config（perf 扩展同源）
      try {
        const { config } = require("@away_from/pth-kernel-interpreter") as typeof import("@away_from/pth-kernel-interpreter");
        config().set(msg.key, msg.value);
        batchLogger?.info?.(`[autopilot] set-param ${msg.key}=${msg.value}`);
        process.send?.({ type: "param-status", batchPid: process.pid, key: msg.key, ok: true });
      } catch (e) {
        process.send?.({ type: "param-status", batchPid: process.pid, key: msg.key, ok: false, error: (e as Error).message });
      }
    } else if (msg?.type === "shutdown") {
      void disposeAllKernels().finally(() => process.exit(0));
    } else if (msg?.type === "pause") {
      controlState.paused = true;
    } else if (msg?.type === "resume") {
      controlState.paused = false;
    } else if (msg?.type === "worker-pause" && typeof msg.role === "string") {
      if (mode === "feasibility") {
        // 显式命名的 role 批量兼容操作：展开为逐 worker 控制，状态/事件仍由共享 runtime 产出。
        const runtime = deps.getRuntime();
        for (const status of runtime.list().filter((s) => s.role.roleId === msg.role)) {
          void runtime.handleControl({ type: "worker-pause", workerId: status.workerId });
        }
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "paused" });
      } else {
        getEventBus().emit("worker.pause", { role: msg.role, batchPid: process.pid });
        for (const l of deps.getLoops()) if (l.role.id === msg.role) l.pause();
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "paused" });
      }
    } else if (msg?.type === "worker-resume" && typeof msg.role === "string") {
      if (mode === "feasibility") {
        const runtime = deps.getRuntime();
        for (const status of runtime.list().filter((s) => s.role.roleId === msg.role)) {
          void runtime.handleControl({ type: "worker-resume", workerId: status.workerId });
        }
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "active" });
      } else {
        getEventBus().emit("worker.resume", { role: msg.role, batchPid: process.pid });
        for (const l of deps.getLoops()) if (l.role.id === msg.role) l.resume();
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "active" });
      }
    } else if (msg?.type === "worker-remove" && typeof msg.role === "string") {
      if (mode === "feasibility") {
        const runtime = deps.getRuntime();
        const targets = runtime.list().filter((s) => s.role.roleId === msg.role).map((s) => s.workerId);
        if (targets.length === 0) {
          process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "removed" });
        } else {
          pendingRoleRemovals.set(msg.role, new Set(targets));
          for (const workerId of targets) {
            void runtime.handleControl({ type: "worker-remove", workerId });
          }
        }
      } else {
        getEventBus().emit("worker.remove", { role: msg.role, batchPid: process.pid });

        // 防御：tick 自驱动链与 splice 并发——map 回调可能拿到已移除的 undefined（竞态窗口）
        const loops = deps.getLoops();
        const idxs = loops.map((l, i) => (l && l.role?.id === msg.role ? i : -1)).filter((i) => i >= 0);
        for (const i of idxs.reverse()) {
          const l = loops[i]!;
          l.stop();
          // Phase 3 条目 11：先 abort in-flight（角色移除时跑飞的程序立即制动）再 dispose 资源
          const k = (l as unknown as { kernel?: { dispose?: () => void; abort?: () => Promise<void> } }).kernel;
          try { void k?.abort?.(); } catch { /* abort 容错 */ }
          try { k?.dispose?.(); } catch { /* dispose 容错 */ }
          // 停复测巡检表（2026-08-14 N6——Optimizer.stop）
          const opt = (l as unknown as { optimizer?: { stop?: () => void } }).optimizer;
          try { opt?.stop?.(); } catch { /* 停表容错 */ }
          loops.splice(i, 1);
        }
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "removed" });
      }
    } else if (msg?.type === "worker-pause" && typeof msg.workerId === "string" && mode === "feasibility") {
      const ack = await deps.getRuntime().handleControl({ type: "worker-pause", workerId: msg.workerId });
      process.send?.({ type: "worker-status", ...ack });
    } else if (msg?.type === "worker-resume" && typeof msg.workerId === "string" && mode === "feasibility") {
      const ack = await deps.getRuntime().handleControl({ type: "worker-resume", workerId: msg.workerId });
      process.send?.({ type: "worker-status", ...ack });
    } else if (msg?.type === "worker-remove" && typeof msg.workerId === "string" && mode === "feasibility") {
      const ack = await deps.getRuntime().handleControl({ type: "worker-remove", workerId: msg.workerId });
      process.send?.({ type: "worker-status", ...ack });
    } else if (msg?.type === "role-register" && msg.role && typeof msg.role === "object") {
      // 分化上线（lineage approve）：batch 内注册新角色 + 创建 worker（树生长——即刻接任务）。
      // 2026-08-13 幂等修复：fork 子进程继承主进程 extraRoles——恢复角色热上线时已在——
      // 直接 createWorker（旧逻辑 registerWorkerRole 抛"已存在"被 catch 吞——worker 不创建）
      try {
        const roleId = (msg.role as { id: string }).id;
        if (!allWorkerRoles().some((r) => r.id === roleId)) {
          registerWorkerRole(msg.role as never);
        }
        const roleDef = knownRoleById(roleId);
        if (roleDef) {
          const w = deps.createWorker(roleDef);
          if (mode === "feasibility") deps.getRuntime().add(deps.makeSlot(w));
          process.send?.({ type: "worker-status", batchPid: process.pid, role: roleDef.id, state: "added", copies: 1, registered: true });
        }
      } catch (e) {
        process.send?.({ type: "worker-status", batchPid: process.pid, role: (msg.role as { id?: string })?.id ?? "?", state: "error", error: (e as Error).message });
      }
    } else if (msg?.type === "worker-add" && typeof msg.role === "string") {
      getEventBus().emit("worker.add", { role: msg.role, copies: msg.copies ?? 1, batchPid: process.pid });
      const roleDef = knownRoleById(msg.role);
      if (roleDef) {
        const copies = Number(msg.copies ?? 1);
        for (let i = 0; i < copies; i++) {
          const w = deps.createWorker(roleDef);
          if (mode === "feasibility") deps.getRuntime().add(deps.makeSlot(w));
        }
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "added", copies });
      } else {
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "error", error: "unknown role" });
      }
    } else if (msg?.type === "optimizer-sweep") {
      // trigger 统一化：主进程 optimizer.deopt-sweep 下行——每 batch 只跑一次（checkDeopt 读共享 memory，无实例态）
      const opt = deps.getLoops()
        .map((l) => (l as unknown as { optimizer?: { sweep?: () => Promise<void> } }).optimizer)
        .find((o) => Boolean(o?.sweep));
      void opt?.sweep?.().catch((e: Error) => {
        batchLogger?.warn?.(`[optimizer-sweep] 巡检失败: ${e.message}`);
      });
      process.send?.({ type: "optimizer-sweep-status", batchPid: process.pid, ran: Boolean(opt) });
    } else if (msg?.type === "intake-due-scan") {
      // N29 Task 6：trigger 只唤醒 due scanner（`Subscription.nextCrawlAt` 是唯一调度真相）。
      // scanner 只建 run + `intake.fetch` outbox 行；阶段推进由生产 drainer 的 intake handler 完成。
      const run = intakeTrigger.run;
      if (!run) {
        process.send?.({ type: "intake-due-scan-status", batchPid: process.pid, ran: false, reason: "intake mode off" });
      } else {
        try {
          const created = await run();
          process.send?.({ type: "intake-due-scan-status", batchPid: process.pid, ran: true, created });
        } catch (e) {
          batchLogger?.warn?.(`[intake] due scan 失败: ${(e as Error).message}`);
          process.send?.({ type: "intake-due-scan-status", batchPid: process.pid, ran: true, error: (e as Error).message });
        }
      }
    } else if (msg?.type === "worker-context-query" && typeof msg.role === "string" && typeof msg.requestId === "string") {
      // W-c：按需在飞上下文查询——只读面，任何异常降级为空结果，绝不影响任务执行。
      try {
        const last = Number(msg.last ?? 10);
        const tasks = liveLoopAccess(deps)
          .filter((l) => l.role === msg.role && l.getActiveTask())
          .map((l) => {
            const active = l.getActiveTask()!;
            const bounded = boundWorkerContext(l.getLiveContext(), last);
            return {
              role: l.role,
              taskId: active.taskId,
              ...(active.currentStep !== undefined ? { step: active.currentStep } : {}),
              ...(active.tool !== undefined ? { tool: active.tool } : {}),
              startedAt: active.startedAt,
              lastActivityAt: active.lastActivityAt,
              ...bounded,
            };
          });
        process.send?.({ type: "worker-context-result", requestId: msg.requestId, tasks });
      } catch (e) {
        batchLogger?.warn?.(`[worker-context-query] 查询失败（降级空）: ${e instanceof Error ? e.message : String(e)}`);
        process.send?.({ type: "worker-context-result", requestId: msg.requestId, tasks: [] });
      }
    }
  });
  // 父进程退出（IPC 通道关闭）→ 自杀：不留孤儿 batch 继续轮询 DB（先释放 kernel）
  process.on("disconnect", () => { void disposeAllKernels().finally(() => process.exit(0)); });

  // trigger 统一化（事件桥上行）：子进程 EventBus → 主进程 ActivityHub（kernel-event IPC）。
  // 白名单去重：task.claim/task.done/task.failed 已走既有 activity 通道，不重复转发（防 trigger 双触发）。
  getEventBus().on("*", (evt) => {
    if (!isForwardableKernelEvent(evt.type)) return;
    try {
      process.send?.({ kind: "kernel-event", event: toKernelActivityEvent(evt, process.pid) });
    } catch { /* IPC 不可用——静默（活动流非关键路径） */ }
  });
}

/**
 * 每轮后发 status 给主进程（v1：tasks 占位空——BatchManager 消费 {type,tasks} 契约）。
 * H6（watchdog v2）：ts 字段 = 心跳时间戳（主进程 watchdog 据此探测挂死）。
 * 2026-08-18 L3：资源自报随心跳（rss/cpu——主进程 listBatches/obs.batches 健康面数据源）。
 * N28 T2：feasibility 模式心跳投影必须来自共享 runtime（不读第二份 slots 数组）；off 保持旧形状。
 *
 * keep-alive（试运行发现修正）：pg 连接池在 Node 24 下不 hold 事件循环（socket 默认 unref），
 * 空闲且仅剩 unref 定时器时进程会立即退出——batch 必须保持存活直到主进程显式 shutdown。
 * 保持定时器引用（不 unref）：进程生命周期与 batch 运行绑定，由 killBatch 的 shutdown 消息
 * 优雅终止（或 5s SIGKILL 兜底）。
 */
export function startBatchStatusReporter(input: {
  mode: "off" | "feasibility";
  getRuntime: () => WorkerSlotRuntime;
  getLoops: () => BatchLoopEntry[];
  memoryDirectory: MemoryDirectorySnapshot | undefined;
  authoritativeWorkingSets: AuthoritativeWorkingSets;
}): NodeJS.Timeout {
  const { mode, getRuntime, getLoops, memoryDirectory, authoritativeWorkingSets } = input;
  const collectActivity = () => liveLoopAccess({ mode, getRuntime, getLoops })
    .map((l) => {
      const active = l.getActiveTask();
      if (!active) return null;
      return {
        role: l.role,
        taskId: active.taskId,
        ...(active.currentStep !== undefined ? { step: active.currentStep } : {}),
        ...(active.tool !== undefined ? { tool: active.tool } : {}),
        startedAt: active.startedAt,
        lastActivityAt: active.lastActivityAt,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return setInterval(() => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const activity = collectActivity();
    if (mode === "feasibility") {
      const directory = memoryDirectory;
      const heartbeat = getRuntime().heartbeat(
        { ts: Date.now(), rss: mem.rss, cpuU: cpu.user, cpuS: cpu.system },
        (workerId) => {
          const responsibilities = directory ? responsibilitiesForWorker(directory, workerId) : [];
          const working = authoritativeWorkingSets.get(workerId);
          return {
            responsibilities: responsibilities.map((r) => ({ regionId: r.regionId, kind: r.kind, priority: r.priority, regionRevision: r.regionRevision })),
            regionWeights: Object.fromEntries(responsibilities.map((r) => {
              const region = directory?.regions.find((x) => x.regionId === r.regionId);
              return [r.regionId, region?.estimatedWeight ?? 0] as const;
            })),
            workingSet: working
              ? {
                  taskId: working.taskId,
                  directorySnapshotId: working.directorySnapshotId,
                  entryIds: working.snapshot.memoryEntryIds,
                  skillIndexIds: working.snapshot.skillIndexIds,
                  activeSkillIds: working.snapshot.activeSkillIds,
                  toolNames: working.snapshot.toolNames,
                  counts: {
                    memoryEntries: working.snapshot.usage.memoryEntries,
                    skillIndexEntries: working.snapshot.usage.skillIndexEntries,
                    activeSkills: working.snapshot.usage.activeSkills,
                    tools: working.snapshot.usage.tools,
                  },
                  usage: working.snapshot.usage,
                  omitted: working.snapshot.omitted,
                }
              : null,
          };
        },
      );
      process.send?.({ ...heartbeat, ...(activity.length > 0 ? { activity } : {}) });
    } else {
      process.send?.({
        type: "status", tasks: [], ts: Date.now(), rss: mem.rss, cpuU: cpu.user, cpuS: cpu.system,
        ...(activity.length > 0 ? { activity } : {}),
      });
    }
  }, 2000);
}
