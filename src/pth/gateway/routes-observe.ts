/**
 * gateway/routes-observe.ts — hub observe 只读观测路由（F/WP4 Task 21）
 *
 * 数据源：Redis 会话痕迹（session:{tenant}:{sid}:meta / entry:{seq} / session-index:{tenant}——
 * WP5 前先行交付；进程重启/会话恢复后依然可观测）。
 *
 * 依赖标注（评审 I1）：EventLog 查询子项经常驻系统会话代理——依赖 WP5 Task 23/24，
 * 拆分为 WP5 收尾时交付（并入 Task 28 验收）。本文件仅实现 Redis 痕迹部分，
 * /events 端点保留占位并显式返回 501（见下）。
 *
 *   GET /api/v1/observe/sessions        会话列表（Redis 会话痕迹）
 *   GET /api/v1/observe/sessions/:id    会话详情（meta——含 entryCount/lastEntrySeq）
 *   GET /api/v1/observe/trace/:id       trace 时间线（该会话全部 entry）
 *   GET /api/v1/observe/events          事件查询（EventLog 代理——WP5 Task 28 交付，暂 501）
 *
 * 租户隔离：SessionStore 键天然按 tenant 分域（key 含 tenantId）——跨租户访问
 * getMeta 返回 null → 404；另加 meta.tenantId 显式校验（纵深防御）。
 */

import type { FastifyInstance } from "fastify";
import type { SessionStore } from "../storage/interfaces.js";

export function registerObserveRoutes(app: FastifyInstance, store: SessionStore) {
  // 会话列表——Redis 会话痕迹（session-index + session meta）
  app.get("/api/v1/observe/sessions", async (req) => {
    const sessions = await store.listSessions(req.auth.tenantId);
    return sessions;
  });

  // 会话详情——meta（entryCount/lastEntrySeq/状态等）
  app.get("/api/v1/observe/sessions/:id", async (req, reply) => {
    const sessionId = (req.params as any).id as string;
    const meta = await store.getMeta(req.auth.tenantId, sessionId);
    if (!meta || meta.tenantId !== req.auth.tenantId) {
      return reply.status(404).send({ error: "Session not found" });
    }
    return meta;
  });

  // trace 时间线——该会话全部 entry（seq 升序）
  app.get("/api/v1/observe/trace/:id", async (req, reply) => {
    const sessionId = (req.params as any).id as string;
    const meta = await store.getMeta(req.auth.tenantId, sessionId);
    if (!meta || meta.tenantId !== req.auth.tenantId) {
      return reply.status(404).send({ error: "Session not found" });
    }
    const entries = await store.getEntries(req.auth.tenantId, sessionId);
    return { sessionId, tenantId: req.auth.tenantId, project: meta.project, entries };
  });

  // 事件查询——EventLog 代理（依赖标注评审 I1）：经常驻系统会话代理查询
  //（agent-lab EventLog）——依赖 WP5 Task 23/24，拆分为 WP5 收尾交付（并入 Task 28）。
  app.get("/api/v1/observe/events", async (_req, reply) => {
    return reply.status(501).send({
      error:
        "EventLog query deferred: requires WP5 Task 23/24 resident system session proxy; delivered with Task 28. " +
        "Redis session traces are available via /observe/sessions and /observe/trace/:id.",
    });
  });
}
