/**
 * bootstrap/worker-slot-runtime.ts —— N28 T2 共享 slot 生命周期运行时。
 *
 * 这是 feasibility 模式下 batch-process 与测试/harness 共同使用的生产组件：
 *  - 唯一拥有 slots 数组（调用方不能绕过清理路径直接增删）；
 *  - `runOnce`/`runAllOnce` 是唯一轮询入口，其 finally 调用内部 `finalizeStoppedSlot()`
 *    恰好一次；
 *  - busy remove 先置 stop-after-task intent（draining），当前任务 finally 完成后观察
 *    stopped，阻止下一轮、await loop.stop()/dispose()、移除 slot 并发出唯一
 *    `worker-removed` 事件；disposal/removal 幂等。
 */

import type { WorkerReplica, WorkerReplicaStatus } from "@away_from/pth-kernel-execution";
import type { RoleDefinition } from "@away_from/pth-kernel-execution";

export type WorkerControlMessage =
  | { type: "worker-pause"; workerId: string }
  | { type: "worker-resume"; workerId: string }
  | { type: "worker-remove"; workerId: string };

export type WorkerSlotEvent =
  | { type: "worker-status"; workerId: string; state: string; accepted: boolean }
  | { type: "worker-removed"; workerId: string };

/** W-b/W-c：worker 在飞活动/实时上下文的统一只读访问面（off loops 与 feasibility slots 共用）。 */
export interface WorkerActiveTask {
  taskId: string;
  roleId: string;
  startedAt: number;
  lastActivityAt: number;
  currentStep?: number;
  tool?: string;
}

export interface WorkerLoopAccess {
  role: string;
  getActiveTask(): WorkerActiveTask | undefined;
  getLiveContext(): unknown;
}

export interface WorkerSlot {
  replica: WorkerReplica;
  role: RoleDefinition;
  loop: { runOnce(): Promise<boolean>; pause(): void; resume(): void; stop(): void; getActiveTask?(): WorkerActiveTask | undefined; getLiveContext?(): unknown };
  dispose: () => Promise<void>;
}

export class WorkerSlotRuntime {
  private readonly slots: WorkerSlot[] = [];
  private readonly finalized = new Set<string>();
  private readonly disposed = new Set<string>();

  constructor(private readonly options: { emit(event: WorkerSlotEvent): void }) {}

  add(slot: WorkerSlot): void {
    this.slots.push(slot);
  }

  private slotOf(workerId: string): WorkerSlot | undefined {
    return this.slots.find((slot) => slot.replica.ref.workerId === workerId);
  }

  private async disposeOnce(slot: WorkerSlot): Promise<void> {
    if (this.disposed.has(slot.replica.ref.workerId)) return;
    this.disposed.add(slot.replica.ref.workerId);
    try {
      await slot.dispose();
    } catch {
      // 清理失败不阻塞移除与最终回执；dispose 幂等标记已落，不会二次调用。
    }
  }

  private async finalizeStoppedSlot(slot: WorkerSlot): Promise<void> {
    const workerId = slot.replica.ref.workerId;
    if (slot.replica.snapshot().state !== "stopped") return;
    if (this.finalized.has(workerId)) return;
    this.finalized.add(workerId);
    slot.loop.stop();
    await this.disposeOnce(slot);
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    this.options.emit({ type: "worker-removed", workerId });
  }

  async runOnce(workerId: string): Promise<boolean> {
    const slot = this.slotOf(workerId);
    if (!slot) return false;
    if (slot.replica.snapshot().state !== "idle") return false;
    try {
      return await slot.loop.runOnce();
    } finally {
      await this.finalizeStoppedSlot(slot);
    }
  }

  async runAllOnce(): Promise<boolean[]> {
    const results: boolean[] = [];
    for (const workerId of this.slots.map((slot) => slot.replica.ref.workerId)) {
      results.push(await this.runOnce(workerId));
    }
    return results;
  }

  heartbeat(
    resource: { ts: number; rss: number; cpuU: number; cpuS: number },
    authoritativeFor?: (workerId: string) => unknown,
  ): {
    type: "status";
    tasks: Array<{ workerId: string; taskId: string }>;
    replicas: Array<WorkerReplicaStatus & { authoritative?: unknown }>;
    ts: number;
    rss: number;
    cpuU: number;
    cpuS: number;
  } {
    const tasks = this.slots
      .map((slot) => slot.replica.snapshot())
      .filter((status): status is WorkerReplicaStatus & { currentTaskId: string } => typeof status.currentTaskId === "string")
      .map((status) => ({ workerId: status.workerId, taskId: status.currentTaskId }));
    return {
      type: "status",
      tasks,
      replicas: this.slots.map((slot) => {
        const status = slot.replica.snapshot();
        return authoritativeFor
          ? { ...status, authoritative: authoritativeFor(status.workerId) }
          : status;
      }),
      ts: resource.ts,
      rss: resource.rss,
      cpuU: resource.cpuU,
      cpuS: resource.cpuS,
    };
  }

  async handleControl(message: WorkerControlMessage): Promise<{ workerId: string; state: string; accepted: boolean }> {
    const slot = this.slotOf(message.workerId);
    if (!slot) return { workerId: message.workerId, state: "unknown", accepted: false };
    const replica = slot.replica;
    if (message.type === "worker-pause") {
      replica.pause();
      slot.loop.pause();
      const result = { workerId: message.workerId, state: replica.snapshot().state, accepted: true };
      this.options.emit({ type: "worker-status", ...result });
      return result;
    }
    if (message.type === "worker-resume") {
      replica.resume();
      slot.loop.resume();
      const result = { workerId: message.workerId, state: replica.snapshot().state, accepted: true };
      this.options.emit({ type: "worker-status", ...result });
      return result;
    }
    // worker-remove：busy 副本进入 draining（stop-after-task），最终移除由
    // runOnce 的 finally 在任务结束后完成；idle/paused 副本立即 stop+dispose+移除。
    replica.requestStop();
    slot.loop.stop();
    const state = replica.snapshot().state;
    const result = { workerId: message.workerId, state, accepted: true };
    this.options.emit({ type: "worker-status", ...result });
    if (state === "stopped") await this.finalizeStoppedSlot(slot);
    return result;
  }

  list(): readonly WorkerReplicaStatus[] {
    return this.slots.map((slot) => slot.replica.snapshot());
  }

  /** W-b/W-c：向 IPC 控制面暴露 slot 内 TaskLoop 的只读访问面（活动/上下文查询共用）。 */
  activeLoops(): WorkerLoopAccess[] {
    return this.slots.map((slot) => ({
      role: slot.role.id,
      getActiveTask: () => slot.loop.getActiveTask?.(),
      getLiveContext: () => slot.loop.getLiveContext?.(),
    }));
  }

  async disposeAll(): Promise<void> {
    for (const slot of [...this.slots]) {
      slot.loop.stop();
      await this.disposeOnce(slot);
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
    }
  }
}
