/**
 * tasking/task-outcome-observers.ts — post-commit observer 契约与隔离工具（模块化 v2 P1-7）。
 *
 * 规则：
 *  - observer 只在 committed=true 时 fan-out；
 *  - 单个 observer 失败不影响其他 observer 与已持久化 outcome；
 *  - 慢 observer（refine/optimizer）走有界后台队列，不阻塞下一轮 claim。
 */

import type { TaskLease, TaskOutcome, TaskWorkItem } from "../contracts/index.js";

export interface TaskOutcomeObserverEvent {
  outcome: TaskOutcome;
  committed: boolean;
  lease: TaskLease;
  work: TaskWorkItem;
  /** 调用方附加的副作用上下文（trace/task/workspace 等——runner 本身不感知） */
  context?: Record<string, unknown>;
}

export type TaskOutcomeObserver = (event: TaskOutcomeObserverEvent) => void | Promise<void>;

export async function notifyObservers(
  observers: readonly TaskOutcomeObserver[],
  event: TaskOutcomeObserverEvent,
  logger?: (msg: string) => void,
): Promise<void> {
  for (const observer of observers) {
    try {
      await observer(event);
    } catch (e) {
      logger?.(`observer failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** 有界后台队列：并发上限内执行慢任务；满则丢弃并告警（绝不允许阻塞 claim 循环） */
export class BoundedBackgroundQueue {
  private running = 0;

  constructor(private opts: { maxConcurrency: number; logger?: (msg: string) => void }) {}

  get active(): number { return this.running; }

  enqueue(fn: () => Promise<void>): void {
    if (this.running >= this.opts.maxConcurrency) {
      this.opts.logger?.(`bounded background queue full (${this.running}/${this.opts.maxConcurrency})——drop slow task`);
      return;
    }
    this.running++;
    void fn().catch((e) => {
      this.opts.logger?.(`background task failed: ${e instanceof Error ? e.message : String(e)}`);
    }).finally(() => {
      this.running--;
    });
  }
}
