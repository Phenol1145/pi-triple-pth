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
