/**
 * gateway/routes-fallback.ts — fallback_requests 回退请求通道路由（F/WP4 Task 20）
 *
 * - POST /api/v1/fallback-requests          手动建单（自动生产者留 E——spec §5.4）
 * - GET  /api/v1/fallback-requests          列表（open 优先）
 * - POST /api/v1/fallback-requests/:id/close 闭合（closedBy 缺省=认证 tenant）
 *
 * respond 自动闭合不在本文件：构件上传 API（routes-programs.ts）携带 requestId 时
 * 保存成功后自动 close（respond 复用 §5.1 上传链路——通道复用，非新协议）。
 */

import type { FastifyInstance } from "fastify";
import type { FallbackRequestStore } from "../fallback/requests.js";

export function registerFallbackRoutes(app: FastifyInstance, store: FallbackRequestStore) {
  app.post("/api/v1/fallback-requests", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const r = await store.create(
      {
        slotHint: body.slotHint as string | undefined,
        description: body.description as string,
        urgency: body.urgency as string | undefined,
      },
      { tenantId: req.auth.tenantId },
    );
    if (!r.ok) return reply.status(400).send({ error: r.error });
    return reply.status(201).send(r.value);
  });

  app.get("/api/v1/fallback-requests", async () => {
    return store.list();
  });

  app.post("/api/v1/fallback-requests/:id/close", async (req, reply) => {
    const id = (req.params as any).id as string;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const closedBy = typeof body.closedBy === "string" ? body.closedBy : req.auth.tenantId;
    const r = await store.close(id, { tenantId: req.auth.tenantId, closedBy });
    if (!r.ok) return reply.status(404).send({ error: r.error });
    return r.value;
  });
}
