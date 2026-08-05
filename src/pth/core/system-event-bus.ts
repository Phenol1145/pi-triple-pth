/**
 * core/system-event-bus.ts — pth 主进程 ↔ 常驻系统会话事件通道（F/WP5 Task 27）
 *
 * 通道设计（关键裁决）：
 *   pth 主进程对 agent-lab **零引用**——事件转发必须经常驻会话的通道。
 *   可行路径（读 Task 24 接线实证）：SDK 扩展 API 的 `pi.events` 即
 *   `DefaultResourceLoader` 的共享 EventBus 实例（loader options.eventBus，
 *   缺省 createEventBus）。因此 pth 主进程自建一个 EventBus 并传入常驻会话的
 *   resource loader → agent-lab（常驻会话内扩展）看到的 `pi.events` 与 pth
 *   持有的是**同一实例**：pth `emit` 外部事件，agent-lab `on` 订阅并喂给
 *   订阅派发器——零引用转发闭环。
 *
 * 通道常量 = 线协议常量：pth 侧（本文件）与 agent-lab 侧（index.ts 内同名
 * 字面量）各自声明、文档互指（与 delegation 通道 `prompt-template:subagent:*`
 * 同模式——协议字符串，非代码引用）。
 */

import type { EventBus } from "../../shared/sdk-adapter/index.js";

/** 外部事件通道名（线协议常量——agent-lab 侧同名定义，见 extensions/agent-lab/index.ts） */
export const EXTERNAL_EVENT_CHANNEL = "platform:external-event";

/**
 * 观察 RPC 通道（Task 28b——方向与 webhook 相反：pth 主进程 → 常驻会话 → DB）。
 * request:  {requestId, filter}   → 常驻会话查 EventLog
 * response: {requestId, events? | error?} ← 常驻会话回传
 * 线协议常量——agent-lab 侧同名定义。
 */
export const OBSERVE_EVENTS_REQUEST_CHANNEL = "platform:observe-events:request";
export const OBSERVE_EVENTS_RESPONSE_CHANNEL = "platform:observe-events:response";

/**
 * 构件绑定通知通道（Task 28c——scheduler/optimizer 空位绑定登记 → 常驻会话注册进框架层 registry）。
 * 线协议常量——agent-lab 侧同名定义。
 */
export const COMPONENT_BOUND_CHANNEL = "platform:component-bound";

/** 事件查询过滤（Task 28b——与 agent-lab EventLog.query 对齐的子集） */
export interface SystemEventFilter {
  eventType?: string;
  /** 评审 WP5-R2 I-1：租户隔离——observe 查询按调用方 tenant 过滤事件流 */
  tenantId?: string;
  since?: number;
  until?: number;
  limit?: number;
}

/** 事件行（结构子集——pth 不直读 agent-lab DB，仅透传常驻会话返回的事件） */
export interface SystemEventEntry {
  eventId: string;
  eventType: string;
  timestamp: number;
  sequence?: number;
  identity: { traceId: string };
  payload: unknown;
}

/** 外部 webhook 事件（POST /api/v1/events 转发载荷） */
export interface ExternalWebhookEvent {
  eventId: string;
  eventType: string;
  payload: unknown;
  /** 事件来源标识（调用方透传，非审计凭据——审计 actor 恒为 "webhook"） */
  source?: string;
  tenantId: string;
  receivedAt: number;
}

/** 构件绑定通知载荷（Task 28c） */
export interface ComponentBoundEvent {
  slotId: string;
  type: string;
  name: string;
  version: number;
  tenantId: string;
}
