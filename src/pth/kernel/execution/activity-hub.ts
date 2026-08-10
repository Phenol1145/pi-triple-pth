/**
 * ActivityHub —— 主进程活动事件聚合器（流式活动状态——console --follow 数据源）。
 *
 * batch 子进程经 IPC 上报活动事件（任务接取/agent step+token 用量/完成）→ 本 Hub 广播给订阅者
 * （SSE /api/v1/kernel/events）。环形缓冲保留最近 N 条（新订阅者先补回放再实时）。
 */
import { EventEmitter } from "node:events";

export interface ActivityEvent {
  kind: string;            // task.claim / agent.step / agent.tool / task.done / task.failed
  taskId?: string;
  role?: string;
  step?: number;
  tool?: string;
  ok?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
  detail?: string;
  batchPid?: number;
  at: number;
  /** trigger 链深（payload.triggeredBy.depth——防链式爆炸） */
  chainDepth?: number;
  /** 来源 trigger id（自触发阻断） */
  triggerId?: string;
}

const BUFFER_MAX = 500;

export class ActivityHub {
  private emitter = new EventEmitter();
  private buffer: ActivityEvent[] = [];

  constructor() {
    this.emitter.setMaxListeners(100);   // SSE 多客户端
  }

  /** batch IPC 上报入口（batch-manager child.on message → publish） */
  publish(e: ActivityEvent): void {
    this.buffer.push(e);
    if (this.buffer.length > BUFFER_MAX) this.buffer.shift();
    this.emitter.emit("activity", e);
  }

  /** 订阅实时事件（返回退订函数） */
  subscribe(handler: (e: ActivityEvent) => void): () => void {
    this.emitter.on("activity", handler);
    return () => this.emitter.off("activity", handler);
  }

  /** 回放缓冲（新订阅者补历史） */
  replay(): ActivityEvent[] {
    return [...this.buffer];
  }

  /** SSE 消费形态：AsyncIterable（writeSSE 复用——先回放后实时） */
  stream(): AsyncIterable<ActivityEvent> {
    const hub = this;
    return {
      [Symbol.asyncIterator]() {
        const queue: ActivityEvent[] = [...hub.replay()];
        let wake: (() => void) | null = null;
        const unsub = hub.subscribe((e) => { queue.push(e); wake?.(); });
        return {
          async next(): Promise<IteratorResult<ActivityEvent>> {
            for (;;) {
              const e = queue.shift();
              if (e) return { value: e, done: false };
              await new Promise<void>((resolve) => { wake = resolve; });
              wake = null;
            }
          },
          async return(): Promise<IteratorResult<ActivityEvent>> {
            unsub();
            return { value: undefined as never, done: true };
          },
        };
      },
    };
  }
}
