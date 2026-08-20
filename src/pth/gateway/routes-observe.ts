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
import type { SessionStore } from "../kernel/storage/session/interfaces.js";
import type { AgentEngine } from "../core/agent-engine.js";
import type { PthGatewayFacade } from "../application/gateway/pth-gateway-facade.js";
import {
  SystemInspectionError,
  SystemInspectionFacade,
  SYSTEM_INSPECTION_MAX_REVISIONS,
} from "../application/observation/system-inspection-facade.js";
import {
  SYSTEM_INSPECTION_DEFAULT_LIMIT,
  SYSTEM_INSPECTION_MAX_LIMIT,
} from "../contracts/system-inspection.js";
import {
  RUNTIME_TIMELINE_MAX_LIMIT,
  RUNTIME_TIMELINE_MAX_RANGE_MS,
  type RuntimeTimelineQuery,
} from "../application/observation/runtime-observation-facade.js";
import {
  isRuntimeIntervalKind,
  isRuntimeIntervalStatus,
  isRuntimeWorkModeFilter,
  RUNTIME_INTERVAL_KINDS,
  RUNTIME_INTERVAL_STATUSES,
  RUNTIME_WORK_MODE_FILTERS,
  type RuntimeIntervalKind,
  type RuntimeIntervalStatus,
  type RuntimeWorkModeFilter,
} from "../contracts/runtime-observation.js";

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

// ─── N30 Task 3：tenant-scoped durable PTH timeline 只读投影路由 ────────────────
// GET /api/v1/observe/timeline?from=&to=&modes=&kinds=&statuses=&limit=&cursor=
// tenant/space 只来自 req.auth（认证钩子盖章）；query/body 自报 tenant 一律忽略。

function parseEpochMs(v: unknown, label: string): number | null | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return n;
}

function parseCommaList(v: unknown, label: string): string[] | null {
  if (v === undefined) return null;
  if (typeof v !== "string" || v.trim() === "") return null;
  return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseModesParam(v: unknown): RuntimeWorkModeFilter[] | null | undefined {
  const raw = parseCommaList(v, "modes");
  if (raw === null) return undefined;
  const modes: RuntimeWorkModeFilter[] = [];
  for (const item of raw) {
    if (!isRuntimeWorkModeFilter(item)) return null;
    modes.push(item);
  }
  return modes;
}

function parseKindsParam(v: unknown): RuntimeIntervalKind[] | null | undefined {
  const raw = parseCommaList(v, "kinds");
  if (raw === null) return undefined;
  const kinds: RuntimeIntervalKind[] = [];
  for (const item of raw) {
    if (!isRuntimeIntervalKind(item)) return null;
    kinds.push(item);
  }
  return kinds;
}

function parseStatusesParam(v: unknown): RuntimeIntervalStatus[] | null | undefined {
  const raw = parseCommaList(v, "statuses");
  if (raw === null) return undefined;
  const statuses: RuntimeIntervalStatus[] = [];
  for (const item of raw) {
    if (!isRuntimeIntervalStatus(item)) return null;
    statuses.push(item);
  }
  return statuses;
}

export function registerRuntimeObservationRoutes(app: FastifyInstance, facade: PthGatewayFacade | null): void {
  app.get("/api/v1/observe/timeline", async (req, reply) => {
    if (!facade) {
      return reply.status(503).send({ error: "kernel unavailable", reason: "DATABASE_URL 未配置或 pg 不可达" });
    }

    const auth = req.auth;
    const query = (req.query ?? {}) as Record<string, unknown>;

    // 1. 时间窗：from/to 为 epoch-ms；缺省最近 1 小时；非法（畸形/from>to/超 7 天）→ 400。
    const now = Date.now();
    const fromRaw = parseEpochMs(query.from, "from");
    const toRaw = parseEpochMs(query.to, "to");
    if (fromRaw === null || toRaw === null) {
      return reply.status(400).send({ error: "from/to must be numeric epoch-ms timestamps" });
    }
    const from = fromRaw ?? now - 3_600_000;
    const to = toRaw ?? now;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0 || from > to) {
      return reply.status(400).send({ error: "malformed window: require 0 <= from <= to" });
    }
    if (to - from > RUNTIME_TIMELINE_MAX_RANGE_MS) {
      return reply.status(400).send({ error: `window range exceeds ${RUNTIME_TIMELINE_MAX_RANGE_MS} ms (7 days)` });
    }

    // 2. limit fail-closed：默认 500，上限 5000。
    const limitRaw = query.limit === undefined ? undefined : Number(query.limit);
    const limit = limitRaw === undefined ? 500 : limitRaw;
    if (!Number.isInteger(limit) || limit < 1 || limit > RUNTIME_TIMELINE_MAX_LIMIT) {
      return reply.status(400).send({ error: `limit must be an integer 1-${RUNTIME_TIMELINE_MAX_LIMIT}` });
    }

    // 3. modes/kinds/statuses：逗号分隔白名单过滤；未知值一律 400。
    const modes = parseModesParam(query.modes);
    if (modes === null) {
      return reply.status(400).send({ error: `unknown mode; allowed: ${RUNTIME_WORK_MODE_FILTERS.join(",")}` });
    }
    const kinds = parseKindsParam(query.kinds);
    if (kinds === null) {
      return reply.status(400).send({ error: `unknown kind; allowed: ${RUNTIME_INTERVAL_KINDS.join(",")}` });
    }
    const statuses = parseStatusesParam(query.statuses);
    if (statuses === null) {
      return reply.status(400).send({ error: `unknown status; allowed: ${RUNTIME_INTERVAL_STATUSES.join(",")}` });
    }

    const cursor = typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : undefined;
    const timelineQuery: RuntimeTimelineQuery = {
      cursor,
      limit,
      ...(modes ? { modes } : {}),
      ...(kinds ? { kinds } : {}),
      ...(statuses ? { statuses } : {}),
    };

    try {
      // 4. tenant/space 只来自认证上下文；query.tenant 即使存在也绝不参与。
      const page = await facade.queryTimeline(
        { tenantId: auth.tenantId, ...(auth.space ? { space: auth.space } : {}) },
        { from, to },
        timelineQuery,
      );
      return page;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.status(statusCode).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// ─── N33 Task 3：Bounded PTH Inspection Projections 只读路由 ─────────────────
// GET /api/v1/observe/workers
// GET /api/v1/observe/memory/entries?type=&kind=&anchor=&statuses=&limit=&cursor=
// GET /api/v1/observe/memory/entries/:id
// GET /api/v1/observe/memory/entries/:id/revisions   （固定最近 10 条，倒序）
// GET /api/v1/observe/memory/summary
// GET /api/v1/observe/config
// GET /api/v1/observe/roles
// tenant/space 只来自 req.auth；query/body 自报 tenant/space 一律 400。

const SYSTEM_INSPECTION_MEMORY_STATUSES = ["official", "draft", "archived", "stale"] as const;

function rejectTenantSpaceOverride(query: Record<string, unknown>): boolean {
  return query.tenant !== undefined || query.space !== undefined;
}

function parseSystemInspectionLimit(raw: unknown): number {
  if (raw === undefined) return SYSTEM_INSPECTION_DEFAULT_LIMIT;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > SYSTEM_INSPECTION_MAX_LIMIT) {
    throw new SystemInspectionError(`limit must be an integer 1-${SYSTEM_INSPECTION_MAX_LIMIT}`);
  }
  return n;
}

function parseMemoryStatusesParam(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    if (!(SYSTEM_INSPECTION_MEMORY_STATUSES as readonly string[]).includes(item)) {
      throw new SystemInspectionError(`unknown memory status: ${item}`);
    }
  }
  return items;
}

function handleSystemInspectionError(reply: { status: (code: number) => { send: (body: unknown) => unknown } }, err: unknown) {
  const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
  return reply.status(statusCode).send({ error: err instanceof Error ? err.message : String(err) });
}

export function registerSystemInspectionRoutes(
  app: FastifyInstance,
  facade: SystemInspectionFacade | null,
): void {
  const unavailable = (reply: { status: (code: number) => { send: (body: unknown) => unknown } }) =>
    reply.status(503).send({ error: "kernel unavailable", reason: "DATABASE_URL 未配置或 pg 不可达" });

  app.get("/api/v1/observe/workers", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const query = (req.query ?? {}) as Record<string, unknown>;
    if (rejectTenantSpaceOverride(query)) {
      return reply.status(400).send({ error: "tenant/space must come from auth" });
    }
    try {
      const auth = req.auth;
      return await facade.queryWorkers({ tenantId: auth.tenantId, ...(auth.space ? { space: auth.space } : {}) });
    } catch (err) {
      return handleSystemInspectionError(reply, err);
    }
  });

  app.get("/api/v1/observe/memory/entries", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const query = (req.query ?? {}) as Record<string, unknown>;
    if (rejectTenantSpaceOverride(query)) {
      return reply.status(400).send({ error: "tenant/space must come from auth" });
    }
    try {
      const auth = req.auth;
      const page = await facade.queryMemory(
        { tenantId: auth.tenantId, ...(auth.space ? { space: auth.space } : {}) },
        {
          limit: parseSystemInspectionLimit(query.limit),
          ...(typeof query.type === "string" && query.type.trim() !== "" ? { type: query.type } : {}),
          ...(typeof query.kind === "string" && query.kind.trim() !== "" ? { kind: query.kind } : {}),
          ...(typeof query.anchor === "string" && query.anchor.trim() !== "" ? { anchor: query.anchor } : {}),
          ...(typeof query.cursor === "string" && query.cursor.length > 0 ? { cursor: query.cursor } : {}),
          ...(parseMemoryStatusesParam(query.statuses) ? { statuses: parseMemoryStatusesParam(query.statuses) } : {}),
        },
      );
      return page;
    } catch (err) {
      return handleSystemInspectionError(reply, err);
    }
  });

  app.get("/api/v1/observe/memory/entries/:id", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const query = (req.query ?? {}) as Record<string, unknown>;
    if (rejectTenantSpaceOverride(query)) {
      return reply.status(400).send({ error: "tenant/space must come from auth" });
    }
    try {
      const auth = req.auth;
      const id = (req.params as Record<string, string>).id;
      const entry = await facade.queryMemoryEntry({ tenantId: auth.tenantId, ...(auth.space ? { space: auth.space } : {}) }, id);
      if (!entry) return reply.status(404).send({ error: "Memory entry not found" });
      return entry;
    } catch (err) {
      return handleSystemInspectionError(reply, err);
    }
  });

  app.get("/api/v1/observe/memory/entries/:id/revisions", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const query = (req.query ?? {}) as Record<string, unknown>;
    if (rejectTenantSpaceOverride(query)) {
      return reply.status(400).send({ error: "tenant/space must come from auth" });
    }
    try {
      const auth = req.auth;
      const id = (req.params as Record<string, string>).id;
      const revisions = await facade.queryMemoryRevisions(
        { tenantId: auth.tenantId, ...(auth.space ? { space: auth.space } : {}) },
        id,
        SYSTEM_INSPECTION_MAX_REVISIONS,
      );
      return { entryId: id, revisions };
    } catch (err) {
      return handleSystemInspectionError(reply, err);
    }
  });

  app.get("/api/v1/observe/memory/summary", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const query = (req.query ?? {}) as Record<string, unknown>;
    if (rejectTenantSpaceOverride(query)) {
      return reply.status(400).send({ error: "tenant/space must come from auth" });
    }
    try {
      const auth = req.auth;
      return await facade.queryMemorySummary(
        { tenantId: auth.tenantId, ...(auth.space ? { space: auth.space } : {}) },
        {
          ...(typeof query.type === "string" && query.type.trim() !== "" ? { type: query.type } : {}),
          ...(typeof query.kind === "string" && query.kind.trim() !== "" ? { kind: query.kind } : {}),
          ...(typeof query.anchor === "string" && query.anchor.trim() !== "" ? { anchor: query.anchor } : {}),
          ...(parseMemoryStatusesParam(query.statuses) ? { statuses: parseMemoryStatusesParam(query.statuses) } : {}),
        },
      );
    } catch (err) {
      return handleSystemInspectionError(reply, err);
    }
  });

  app.get("/api/v1/observe/config", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const query = (req.query ?? {}) as Record<string, unknown>;
    if (rejectTenantSpaceOverride(query)) {
      return reply.status(400).send({ error: "tenant/space must come from auth" });
    }
    try {
      return await facade.queryConfig();
    } catch (err) {
      return handleSystemInspectionError(reply, err);
    }
  });

  app.get("/api/v1/observe/roles", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const query = (req.query ?? {}) as Record<string, unknown>;
    if (rejectTenantSpaceOverride(query)) {
      return reply.status(400).send({ error: "tenant/space must come from auth" });
    }
    try {
      return facade.queryRoles();
    } catch (err) {
      return handleSystemInspectionError(reply, err);
    }
  });
}
