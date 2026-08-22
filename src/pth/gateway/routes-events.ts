/**
 * gateway/routes-events.ts — 外部事件 webhook 入口（F/WP5 Task 27）
 *
 *   POST /api/v1/events  {eventType, payload, source}
 *
 * 权限：复用全局 createAuthHook（Bearer + tenant 归属）——无 Bearer → 401；
 * 事件归属 = 认证 tenant（服务端派生，不接受调用方自报租户——纵深防御）。
 * 审计：每次接收落 audit:log（actor="webhook"）。
 * 转发：engine.emitExternalEvent → 常驻会话共享 EventBus（pi.events emit，
 * 零引用通道——见 core/system-event-bus.ts）→ 常驻会话内 agent-lab 订阅
 * → 订阅派发器 → dispatch。常驻会话不可用（未构建/已崩溃）→ 503（审计仍先落，
 * 调用方可重试——事件不静默丢弃）。
 *
 * 幂等：事件不重放（审计+转发均为单次；重试由调用方决策，eventId 由平台生成）。
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AgentEngine } from "../core/index.js";
import type { AuditWriter } from "../observability/index.js";

export function registerEventsRoutes(app: FastifyInstance, engine: AgentEngine, audit?: AuditWriter) {
  app.post("/api/v1/events", async (req, reply) => {
    const tenantId = req.auth.tenantId;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const eventType = body.eventType;
    if (typeof eventType !== "string" || eventType.trim().length === 0) {
      return reply.status(400).send({ error: "eventType is required (non-empty string)" });
    }
    if (eventType.length > 256) {
      return reply.status(400).send({ error: "eventType too long (max 256)" });
    }
    if (body.payload !== undefined && (typeof body.payload !== "object" || body.payload === null || Array.isArray(body.payload))) {
      return reply.status(400).send({ error: "payload must be a JSON object when present" });
    }
    if (body.source !== undefined && typeof body.source !== "string") {
      return reply.status(400).send({ error: "source must be a string when present" });
    }

    const eventId = crypto.randomUUID();
    const payload = body.payload as Record<string, unknown> | undefined;
    const source = body.source as string | undefined;

    // 事件落审计（先于转发——转发失败也要可追溯）
    await audit?.write({
      tenantId,
      actor: "webhook",
      action: "external_event_received",
      details: {
        eventId,
        eventType,
        source,
        ...(payload !== undefined ? { hasPayload: true } : {}),
      },
    });

    const delivered = engine.emitExternalEvent({
      eventId,
      eventType,
      payload,
      source,
      tenantId,
    });
    if (!delivered) {
      return reply.status(503).send({
        error: "system session unavailable: external event accepted for audit but not delivered",
        eventId,
      });
    }

    return reply.status(202).send({ accepted: true, eventId, eventType, tenantId });
  });
}
