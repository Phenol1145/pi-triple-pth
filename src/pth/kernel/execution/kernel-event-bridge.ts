/**
 * kernel-event-bridge.ts —— 统一事件桥（上行：batch 子进程 EventBus → 主进程 ActivityHub）。
 *
 * trigger 统一化（2026-08-16）：ActivityHub 是 trigger 的唯一事件源，而 batch 子进程
 * 的 EventBus 是进程内单例。本模块定义：
 *  - 上行转发白名单（task.claim/task.done/task.failed 走既有 activity 通道，不重复转发——
 *    防止同一 trigger 双触发）；
 *  - EventBus KernelEvent → ActivityEvent 的字段归一。
 *
 * 主进程侧 BatchManager 收到 {kind:"kernel-event"} 后直接 publish 到 ActivityHub；
 * 主进程自身的 batch.spawn/batch.kill 由 assembly 桥接（同一条归一函数）。
 */

import type { KernelEvent } from "./event-bus.js";
import type { ActivityEvent } from "./activity-hub.js";

/** 上行白名单：batch 子进程 EventBus → 主进程 ActivityHub */
export const KERNEL_EVENT_FORWARD_KINDS = new Set<string>([
  "task.execute.start",
  "task.execute.end",
  "task.submit",
  "task.reject",
  "kernel.execute.start",
  "kernel.execute.end",
  "worker.add",
  "worker.pause",
  "worker.resume",
  "worker.remove",
]);

/** 是否应经 kernel-event IPC 上行（去重：activity 通道已覆盖的种类不再转发） */
export function isForwardableKernelEvent(type: string): boolean {
  return KERNEL_EVENT_FORWARD_KINDS.has(type);
}

/** EventBus KernelEvent → ActivityHub ActivityEvent 字段归一（batchPid 由发送方注入） */
export function toKernelActivityEvent(evt: KernelEvent, batchPid: number): ActivityEvent {
  const p = evt.payload as Record<string, unknown>;
  const detail = typeof p.reason === "string" ? p.reason
    : typeof p.detail === "string" ? p.detail
    : undefined;
  return {
    kind: evt.type,
    taskId: typeof p.taskId === "string" ? p.taskId : undefined,
    role: typeof p.role === "string" ? p.role : undefined,
    ok: typeof p.ok === "boolean" ? p.ok : undefined,
    detail,
    batchPid,
    at: evt.ts,
    ...(typeof p.durationMs === "number" ? { durationMs: p.durationMs } : {}),
    ...(typeof p.batchId === "string" ? { batchId: p.batchId } : {}),
    ...(Array.isArray(p.tags) ? { tags: p.tags as string[] } : {}),
  };
}
