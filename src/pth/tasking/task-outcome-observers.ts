/**
 * tasking/task-outcome-observers.ts — post-commit observer 契约与隔离工具（模块化 v2 P1-7 / R4）。
 *
 * 规则：
 *  - observer 只在 committed=true 时 fan-out；
 *  - observer 可带 name/stage（R4/P1-5），错误日志与 durable failure 都携带该上下文；
 *  - 关键持久化 observer（durable=true）失败会写入 observer-failure durable record；
 *  - 单个 observer 失败不影响其他 observer 与已持久化 outcome；
 *  - 慢 observer（optimizer）走有界后台队列，不阻塞下一轮 claim。
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

export type TaskOutcomeObserverFn = (event: TaskOutcomeObserverEvent) => void | Promise<void>;

/** 命名 observer（R4/P1-5）：name/stage 进入失败日志与 durable failure 记录。 */
export interface NamedTaskOutcomeObserver {
  name: string;
  stage?: string;
  /** 关键持久化 observer 失败需写 durable failure（默认 false）。 */
  durable?: boolean;
  observe: TaskOutcomeObserverFn;
}

export type TaskOutcomeObserver = TaskOutcomeObserverFn | NamedTaskOutcomeObserver;

export interface ObserverFailureRecord {
  observerName: string;
  stage?: string;
  message: string;
  stack?: string;
  taskId: string;
  tenantId: string;
}

export interface NotifyObserversOptions {
  logger?: (msg: string) => void;
  recordFailure?: (failure: ObserverFailureRecord) => void | Promise<void>;
}

function isNamed(observer: TaskOutcomeObserver): observer is NamedTaskOutcomeObserver {
  return typeof observer === "object" && observer !== null && "observe" in observer;
}

export async function notifyObservers(
  observers: readonly TaskOutcomeObserver[],
  event: TaskOutcomeObserverEvent,
  loggerOrOpts?: NotifyObserversOptions | ((msg: string) => void),
): Promise<void> {
  const opts: NotifyObserversOptions =
    typeof loggerOrOpts === "function" ? { logger: loggerOrOpts } : (loggerOrOpts ?? {});
  const { logger, recordFailure } = opts;

  for (const observer of observers) {
    const named = isNamed(observer);
    const name = named ? observer.name : (observer.name || "anonymous");
    const stage = named ? observer.stage : undefined;
    try {
      await (named ? observer.observe(event) : observer(event));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const context = stage ? `[${name}:${stage}]` : `[${name}]`;
      logger?.(`observer failed ${context}: ${message}`);
      if (named && observer.durable) {
        try {
          await recordFailure?.({
            observerName: name,
            stage,
            message,
            stack: e instanceof Error ? e.stack : undefined,
            taskId: event.work.taskId,
            tenantId: event.work.scope.tenantId,
          });
        } catch (recordErr) {
          logger?.(`observer failure recording failed ${context}: ${recordErr instanceof Error ? recordErr.message : String(recordErr)}`);
        }
      }
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
