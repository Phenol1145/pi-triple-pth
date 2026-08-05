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
import type { AgentEngine } from "../core/agent-engine.js";

/**
 * 事件查询过滤参数解析（eventType/since/until/limit——与 EventLog.query 对齐）。
 */
function parseEventFilter(query: Record<string, unknown>): {
  ok: true;
  filter: { eventType?: string; since?: number; until?: number; limit?: number };
} | { ok: false; error: string } {
  const filter: { eventType?: string; since?: number; until?: number; limit?: number } = {};
  if (query.eventType !== undefined) {
    if (typeof query.eventType !== "string" || query.eventType.length === 0) {
      return { ok: false, error: "eventType must be a non-empty string" };
    }
    filter.eventType = query.eventType;
  }
  for (const [key, v] of [
    ["since", query.since],
    ["until", query.until],
  ] as const) {
    if (v !== undefined) {
      const n = typeof v === "string" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) {
        return { ok: false, error: `${key} must be a numeric timestamp` };
      }
      (filter as Record<string, number>)[key] = n;
    }
  }
  if (query.limit !== undefined) {
    const n = typeof query.limit === "string" ? Number(query.limit) : query.limit;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10000) {
      return { ok: false, error: "limit must be an integer 1-10000" };
    }
    filter.limit = n;
  }
  return { ok: true, filter };
}

export function registerObserveRoutes(
  app: FastifyInstance,
  store: SessionStore,
  /** F/WP5 Task 28b：常驻会话 EventLog 代理查询入口（经 system-event-bus RPC）。可选——不传则 /events 保持 501。 */
  engine?: AgentEngine,
) {
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

  // 事件查询——常驻会话 EventLog 代理（F/WP5 Task 28b：评审 I1 拆分子项落地）。
  // 方向与 webhook 相反：pth 主进程 → 常驻会话 → agent-lab DB（EventLog）→ 回传。
  // pth 不直读 agent-lab DB——经常驻会话通道 request/response RPC（engine.querySystemEvents）。
  // 评审 WP5-R2 I-1：跨租户事件隔离——filter 强制带调用方 tenantId（req.auth.tenantId），
  // agent-lab 侧按 identity_json.tenantId 过滤；不再"多租户事件混排"。
  app.get("/api/v1/observe/events", async (req, reply) => {
    if (!engine) {
      return reply.status(501).send({
        error:
          "EventLog query deferred: requires WP5 Task 23/24 resident system session proxy; delivered with Task 28. " +
          "Redis session traces are available via /observe/sessions and /observe/trace/:id.",
      });
    }
    const parsed = parseEventFilter((req.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) return reply.status(400).send({ error: parsed.error });
    const r = await engine.querySystemEvents({ ...parsed.filter, tenantId: req.auth.tenantId });
    if (!r.ok) {
      return reply.status(502).send({ error: `event log query failed: ${r.error}` });
    }
    return { tenantId: req.auth.tenantId, count: r.data.length, events: r.data };
  });
}
