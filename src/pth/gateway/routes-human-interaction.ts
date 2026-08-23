/**
 * routes-human-interaction.ts — 通用人工审核 HTTP API（N25）。
 *
 *   POST   /api/v1/human-requests                 创建人工请求（任务进入 waiting-human）
 *   GET    /api/v1/human-requests                 列表（?status=&limit=）
 *   GET    /api/v1/human-requests/:id             详情
 *   POST   /api/v1/human-requests/:id/responses   响应（approve/reject；CAS + 幂等）
 *   POST   /api/v1/human-requests/:id/cancel      取消
 *
 * 认证：tenant/principal 一律取自 auth hook；body 不得自报 tenant/principal。
 */

import type { FastifyInstance } from "fastify";
import type { PthGatewayFacade } from "../application/index.js";

const UNAVAILABLE = { error: "kernel unavailable", reason: "DATABASE_URL 未配置或 pg 不可达" };

interface AuthLike {
  tenantId?: string;
  principalId?: string;
  role?: string;
}

function authOf(req: unknown): AuthLike | undefined {
  return (req as { auth?: AuthLike }).auth;
}

export function registerHumanInteractionRoutes(app: FastifyInstance, facade: PthGatewayFacade | null): void {
  const unavailable = (reply: { status: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.status(503).send(UNAVAILABLE);

  app.post("/api/v1/human-requests", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const auth = authOf(req);
    if (!auth?.tenantId) return reply.status(401).send({ error: "human-requests requires authenticated tenant" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.tenantId !== undefined || body.principalId !== undefined || body.createdBy !== undefined) {
      return reply.status(400).send({ error: "tenantId/principalId/createdBy 必须由服务端 auth 盖章，body 不得自报" });
    }
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    const kind = typeof body.kind === "string" ? body.kind.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!taskId || !kind || !title || !text) {
      return reply.status(400).send({ error: "taskId/kind/title/body required" });
    }
    const assignedTo = Array.isArray(body.assignedTo)
      ? body.assignedTo.filter((x): x is string => typeof x === "string" && x.trim() !== "")
      : undefined;
    const policySelector = typeof body.policySelector === "string" ? body.policySelector.trim() : undefined;
    const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : undefined;
    const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() !== "" ? body.idempotencyKey.trim() : undefined;
    try {
      const result = await facade.createHumanRequest({
        tenantId: auth.tenantId,
        taskId,
        kind,
        title,
        body: text,
        ...(assignedTo ? { assignedTo } : {}),
        ...(policySelector ? { policySelector } : {}),
        createdBy: auth.principalId ?? `tenant:${auth.tenantId}:${auth.role ?? "tenant-agent"}`,
        ...(expiresAt ? { expiresAt } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      return reply.status(201).send(result);
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.status(e.statusCode ?? 400).send({ error: e.message });
    }
  });

  app.get("/api/v1/human-requests", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const auth = authOf(req);
    if (!auth?.tenantId) return reply.status(401).send({ error: "human-requests requires authenticated tenant" });
    const q = (req.query ?? {}) as Record<string, unknown>;
    const status = typeof q.status === "string" && q.status.trim() !== "" ? q.status.trim() : undefined;
    const limit = typeof q.limit === "string" ? Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200) : 50;
    const result = await facade.listHumanRequests({ tenantId: auth.tenantId, ...(status ? { status } : {}), limit });
    return result;
  });

  app.get("/api/v1/human-requests/:id", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const auth = authOf(req);
    if (!auth?.tenantId) return reply.status(401).send({ error: "human-requests requires authenticated tenant" });
    const { id } = req.params as { id: string };
    const result = await facade.getHumanRequest(id, auth.tenantId);
    return result ?? reply.status(404).send({ error: "human request not found", id });
  });

  app.post("/api/v1/human-requests/:id/responses", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const auth = authOf(req);
    if (!auth?.tenantId) return reply.status(401).send({ error: "human-requests requires authenticated tenant" });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = body.decision === "approved" || body.decision === "rejected" ? body.decision : null;
    if (!decision) return reply.status(400).send({ error: "decision required: approved|rejected" });
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() !== "" ? body.idempotencyKey.trim() : undefined;
    try {
      const result = await facade.respondHumanRequest({
        requestId: id,
        decision,
        ...(reason !== undefined ? { reason } : {}),
        principalId: auth.principalId ?? `tenant:${auth.tenantId}:${auth.role ?? "tenant-agent"}`,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }, auth.tenantId);
      return result;
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.status(e.statusCode ?? 400).send({ error: e.message });
    }
  });

  app.post("/api/v1/human-requests/:id/cancel", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const auth = authOf(req);
    if (!auth?.tenantId) return reply.status(401).send({ error: "human-requests requires authenticated tenant" });
    const { id } = req.params as { id: string };
    const result = await facade.cancelHumanRequest(id, auth.tenantId, auth.principalId ?? `tenant:${auth.tenantId}:${auth.role ?? "tenant-agent"}`);
    return result ?? reply.status(404).send({ error: "human request not found", id });
  });
}
