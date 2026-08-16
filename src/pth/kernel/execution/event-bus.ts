/**
 * event-bus.ts —— PTH 事件总线（兼容性扩展接口 P1——SPEC 2026-08-09）
 *
 * 域×动作两维事件（task/kernel/compiled/agent/worker/batch/refine/memory/resolver/debug）。
 * 语义：fire-and-forget（异步分发——handler 失败仅记日志不影响主流程）；
 * 副作用白名单（handler 可写 memory/fs/llm——递归触发同事件阻断（emit 深度限 1）。
 *
 * 多 batch 兼容：EventBus 是每 batch 进程内实例（batch 内就近 emit/订阅——零 IPC）；
 * batch 级事件（spawn/kill——assembly/main 侧）用独立 bus 实例——多 batch 天然隔离。
 */

export interface KernelEvent {
  /** 域×动作（如 task.execute.start / kernel.acquire） */
  type: string;
  /** 事件载荷（域语义——taskId/role/kernelId/durationMs 等） */
  payload: Record<string, unknown>;
  /** 时间戳 */
  ts: number;
}

export type KernelEventHandler = (event: KernelEvent) => Promise<void> | void;

export interface EventBusOptions {
  /** handler 失败回调（默认 console.error——可注入 logger） */
  onError?: (event: KernelEvent, err: Error) => void;
}

export class KernelEventBus {
  private handlers = new Map<string, Set<KernelEventHandler>>();
  // 递归防护：fire-and-forget 的 handler 在微任务执行——emitDepth 同步栈计数失效
  // （handler 内再 emit 同事件 → 无限循环挂起——P1 测试发现）。改为 in-flight 事件标记：
  // 同类型事件 handler 执行期间，该事件的 emit 被阻断（handler 完成后清除）。
  private inFlight = new Set<string>();

  constructor(private opts: EventBusOptions = {}) {}

  /** 订阅事件（域×动作——支持前缀通配：task.* 订阅 task 域全部）。返回退订函数。 */
  on(pattern: string, handler: KernelEventHandler): () => void {
    if (!this.handlers.has(pattern)) this.handlers.set(pattern, new Set());
    this.handlers.get(pattern)!.add(handler);
    return () => this.handlers.get(pattern)?.delete(handler);
  }

  /** 退订 */
  off(pattern: string, handler: KernelEventHandler): void {
    this.handlers.get(pattern)?.delete(handler);
  }

  /** 匹配：task.execute.start → [task.execute.start, task.*, *] */
  private patterns(type: string): string[] {
    const domain = type.split(".")[0] ?? "";
    return [type, `${domain}.*`, "*"];
  }

  /** 发射（fire-and-forget——不 await handler；失败记日志；同事件递归阻断） */
  emit(type: string, payload: Record<string, unknown> = {}): void {
    if (this.inFlight.has(type)) return;   // 同事件递归阻断（handler 执行中）
    const event: KernelEvent = { type, payload, ts: Date.now() };
    this.inFlight.add(type);
    let remaining = 0;
    const markDone = () => { if (--remaining <= 0) this.inFlight.delete(type); };
    for (const pattern of this.patterns(type)) {
      for (const handler of this.handlers.get(pattern) ?? []) {
        remaining++;
        void Promise.resolve()
          .then(() => handler(event))
          .catch((err: Error) => {
            this.opts.onError?.(event, err) ?? console.error(`[event-bus] handler failed for ${type}:`, err.message);
          })
          .finally(markDone);
      }
    }
    if (remaining === 0) this.inFlight.delete(type);   // 无 handler——立即清除
  }

  /** 订阅数（监控/调试） */
  get handlerCount(): number {
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }
}

/** 单例（batch 进程内共享——每 batch 独立实例——多 batch 天然隔离） */
let globalBus: KernelEventBus | null = null;
export function getEventBus(): KernelEventBus {
  if (!globalBus) globalBus = new KernelEventBus();
  return globalBus;
}
/** 测试用：重置单例 */
export function resetEventBus(): void { globalBus = null; }
