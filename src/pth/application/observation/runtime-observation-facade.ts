/**
 * application/observation/runtime-observation-facade.ts — N30 Task 3 只读时间线投影。
 *
 * 约束（plan Task 3 / design §3.1 / §4.2 / §5.1）：
 *  - SQL 恒带 tenant 谓词 + 时间重叠谓词；绝不先全量读出再过滤。
 *  - 按 (startAt, sourceVersion, stableId) 排序；opaque cursor 只承载排序位置。
 *  - limit 默认 500，上限 5000——超过或非法一律 fail-closed 400。
 *  - Task 行 workMode 来自 durable `tasks.work_mode`；Intake Run/Stage 固定 `intake`；
 *    优化任务行即 `tasks.work_mode = 'optimize'`，由同一 task 分支投影（固定语义不另造表）。
 *  - 不读 ActivityHub 历史；不写任何领域源表。
 */

import type pg from "pg";
import { isWorkMode } from "../../contracts/work-mode.js";
import {
  buildRuntimeIntervalId,
  isRuntimeIntervalKind,
  isRuntimeIntervalStatus,
  isRuntimeWorkModeFilter,
  RUNTIME_WORK_MODE_FILTERS,
  type RuntimeInterval,
  type RuntimeIntervalKind,
  type RuntimeIntervalStatus,
  type RuntimeWorkMode,
  type RuntimeWorkModeFilter,
} from "../../contracts/runtime-observation.js";

export const RUNTIME_TIMELINE_MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
export const RUNTIME_TIMELINE_DEFAULT_LIMIT = 500;
export const RUNTIME_TIMELINE_MAX_LIMIT = 5000;

export interface RuntimeObservationScope {
  tenantId: string;
  space?: string;
}

export interface RuntimeObservationWindow {
  from: number;
  to: number;
}

export interface RuntimeTimelineQuery {
  cursor?: string | null;
  limit?: number;
  modes?: readonly RuntimeWorkModeFilter[];
  kinds?: readonly RuntimeIntervalKind[];
  statuses?: readonly RuntimeIntervalStatus[];
}

export interface RuntimeTimelinePage {
  intervals: RuntimeInterval[];
  nextCursor: string | null;
  window: { from: number; to: number };
  scope: { mode: "local-admin"; tenantId: string; space?: string };
  sourceObservedAt: number;
  collectedAt: number;
}

/** 投影调用非法参数统一 400；路由层直接透传 statusCode。 */
export class RuntimeObservationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "RuntimeObservationError";
  }
}

interface CursorPayload {
  v: 1;
  tenantId: string;
  startAt: number;
  sourceVersion: string;
  id: string;
}

type SqlRow = Record<string, any>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function encodeCursor(cursor: CursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(input: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(input, "base64url").toString("utf8"));
  } catch {
    throw new RuntimeObservationError("cursor malformed");
  }
  if (!isRecord(parsed) || parsed.v !== 1) {
    throw new RuntimeObservationError("cursor malformed: unknown version");
  }
  const { tenantId, startAt, sourceVersion, id } = parsed;
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new RuntimeObservationError("cursor malformed: tenantId");
  }
  if (typeof startAt !== "number" || !Number.isFinite(startAt) || startAt < 0) {
    throw new RuntimeObservationError("cursor malformed: startAt");
  }
  if (typeof sourceVersion !== "string" || sourceVersion.trim() === "") {
    throw new RuntimeObservationError("cursor malformed: sourceVersion");
  }
  if (typeof id !== "string" || id.trim() === "") {
    throw new RuntimeObservationError("cursor malformed: id");
  }
  return { v: 1, tenantId, startAt, sourceVersion, id };
}

function parseModes(modes?: readonly RuntimeWorkModeFilter[]): string[] | null {
  if (!modes || modes.length === 0) return null;
  for (const mode of modes) {
    if (!isRuntimeWorkModeFilter(mode)) {
      throw new RuntimeObservationError(`unknown mode: ${String(mode)}`);
    }
  }
  if (modes.includes("all")) return null;
  return [...new Set(modes)];
}

function parseKinds(kinds?: readonly RuntimeIntervalKind[]): string[] | null {
  if (!kinds || kinds.length === 0) return null;
  for (const kind of kinds) {
    if (!isRuntimeIntervalKind(kind)) {
      throw new RuntimeObservationError(`unknown kind: ${String(kind)}`);
    }
  }
  return [...new Set(kinds)];
}

function parseStatuses(statuses?: readonly RuntimeIntervalStatus[]): string[] | null {
  if (!statuses || statuses.length === 0) return null;
  for (const status of statuses) {
    if (!isRuntimeIntervalStatus(status)) {
      throw new RuntimeObservationError(`unknown status: ${String(status)}`);
    }
  }
  return [...new Set(statuses)];
}

export class RuntimeObservationFacade {
  readonly #pool: pg.Pool;
  readonly #clock: () => number;

  constructor(pool: pg.Pool, opts: { clock?: () => number } = {}) {
    this.#pool = pool;
    this.#clock = opts.clock ?? (() => Date.now());
  }

  async queryTimeline(
    scope: RuntimeObservationScope,
    window: RuntimeObservationWindow,
    cursorOrQuery?: string | RuntimeTimelineQuery | null,
  ): Promise<RuntimeTimelinePage> {
    // ── 入参 fail-closed（tenant 只接受认证上下文，不接受任何自报来源） ──
    if (!isRecord(scope) || typeof scope.tenantId !== "string" || scope.tenantId.trim() === "") {
      throw new RuntimeObservationError("scope.tenantId must be a non-empty string (from auth)");
    }
    if (scope.space !== undefined && (typeof scope.space !== "string" || scope.space.trim() === "")) {
      throw new RuntimeObservationError("scope.space must be a non-empty string when present");
    }
    if (!isRecord(window) || typeof window.from !== "number" || typeof window.to !== "number"
      || !Number.isFinite(window.from) || !Number.isFinite(window.to)
      || window.from < 0 || window.to < 0 || window.to < window.from) {
      throw new RuntimeObservationError("window.from/window.to must be non-negative epoch-ms with from <= to");
    }
    if (window.to - window.from > RUNTIME_TIMELINE_MAX_RANGE_MS) {
      throw new RuntimeObservationError(
        `window range exceeds ${RUNTIME_TIMELINE_MAX_RANGE_MS} ms (7 days)`,
      );
    }

    const query = typeof cursorOrQuery === "string" || cursorOrQuery === null || cursorOrQuery === undefined
      ? { cursor: cursorOrQuery ?? null }
      : cursorOrQuery;

    const limit = query.limit ?? RUNTIME_TIMELINE_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > RUNTIME_TIMELINE_MAX_LIMIT) {
      throw new RuntimeObservationError(
        `limit must be an integer 1-${RUNTIME_TIMELINE_MAX_LIMIT} (fail-closed)`,
      );
    }

    const modes = parseModes(query.modes);
    const kinds = parseKinds(query.kinds);
    const statuses = parseStatuses(query.statuses);

    const cursor = query.cursor
      ? decodeCursor(query.cursor)
      : null;
    if (cursor && cursor.tenantId !== scope.tenantId) {
      // 跨 tenant cursor 一律拒绝：cursor 不能携带另一租户的排序位置。
      throw new RuntimeObservationError("cursor tenant mismatch (fail-closed)");
    }

    const fromTs = new Date(window.from).toISOString();
    const toTs = new Date(window.to).toISOString();
    const params: unknown[] = [
      scope.tenantId,
      fromTs,
      toTs,
      modes,
      kinds,
      statuses,
      cursor?.startAt ?? null,
      cursor?.sourceVersion ?? null,
      cursor?.id ?? null,
      limit + 1,
    ];

    const sql = TIMELINE_SQL;

    // ── 只读投影：本方法只有 pool.query，没有任何 INSERT/UPDATE/DELETE。 ──
    const result = await this.#pool.query<SqlRow>(sql, params);

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const collectedAt = this.#clock();
    const sourceObservedAt = collectedAt;

    const intervals = pageRows.map((row) => this.#mapRow(row, sourceObservedAt, collectedAt));

    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor({
          v: 1,
          tenantId: scope.tenantId,
          startAt: Number(last.start_ms),
          sourceVersion: String(last.source_version),
          id: String(last.stable_id),
        })
      : null;

    return {
      intervals,
      nextCursor,
      window: { from: window.from, to: window.to },
      scope: { mode: "local-admin", tenantId: scope.tenantId, ...(scope.space ? { space: scope.space } : {}) },
      sourceObservedAt,
      collectedAt,
    };
  }

  #mapRow(row: SqlRow, sourceObservedAt: number, collectedAt: number): RuntimeInterval {
    const tenantId = String(row.tenant_id);
    const kind = row.interval_kind as RuntimeIntervalKind;
    const stableId = String(row.stable_id);
    const workModeRaw = row.work_mode as unknown;
    const workMode: RuntimeWorkMode = isWorkMode(workModeRaw) ? workModeRaw : "run";
    const status: RuntimeIntervalStatus = isRuntimeIntervalStatus(row.status) ? row.status : "unknown";
    const startAt = Number(row.start_ms);
    const endAt = row.end_ms === null || row.end_ms === undefined ? null : Number(row.end_ms);

    const parentId = kind === "intake-stage"
      ? buildRuntimeIntervalId("intake-run", String(row.run_id), tenantId)
      : row.job_id
        ? buildRuntimeIntervalId("job", String(row.job_id), tenantId)
        : undefined;

    return {
      id: stableId,
      ...(parentId ? { parentId } : {}),
      kind,
      workMode,
      label: String(row.label),
      status,
      sourceVersion: String(row.source_version),
      startAt,
      endAt,
      freshness: {
        sourceObservedAt,
        collectedAt,
        expectedIntervalMs: 5000,
        staleAfterMs: 15000,
      },
      tenantId,
      ...(row.task_id ? { taskId: String(row.task_id) } : {}),
      ...(row.run_id ? { runId: String(row.run_id) } : {}),
      ...(row.stage ? { stage: String(row.stage) } : {}),
      ...(row.attempt !== null && row.attempt !== undefined ? { attempt: Number(row.attempt) } : {}),
      ...(row.worker_id ? { workerId: String(row.worker_id) } : {}),
      ...(row.role_id ? { roleId: String(row.role_id) } : {}),
      ...(row.batch_id ? { batchId: String(row.batch_id) } : {}),
      ...(row.trace_id ? { traceId: String(row.trace_id) } : {}),
    };
  }
}

const TIMELINE_SQL = `
SELECT * FROM (
  -- ── Task：workMode 来自 durable tasks.work_mode ──────────────────────────
  SELECT
    'task'::text AS interval_kind,
    t.tenant_id,
    'task:' || t.tenant_id || ':' || t.id AS stable_id,
    t.work_mode AS work_mode,
    t.title AS label,
    CASE
      WHEN t.status = 'pending' AND jsonb_array_length(COALESCE(t.rejects, '[]'::jsonb)) > 0 THEN 'retrying'
      WHEN t.status = 'pending' THEN 'queued'
      WHEN t.status = 'claimed' THEN 'running'
      WHEN t.status = 'submitted' THEN 'waiting'
      WHEN t.status = 'completed' THEN 'completed'
      WHEN t.status IN ('rejected','escalated') THEN 'failed'
      ELSE 'unknown'
    END AS status,
    (EXTRACT(EPOCH FROM t.created_at) * 1000)::bigint AS start_ms,
    CASE
      WHEN t.status IN ('completed','rejected','escalated') THEN
        (EXTRACT(EPOCH FROM COALESCE(t.completed_at, t.escalated_at, t.updated_at)) * 1000)::bigint
      ELSE NULL
    END AS end_ms,
    to_char(t.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS source_version,
    t.job_id AS job_id,
    t.id AS task_id,
    NULL::text AS run_id,
    NULL::text AS stage,
    NULL::int AS attempt,
    t.claimed_by AS worker_id,
    t.assigned_role AS role_id,
    NULL::text AS batch_id,
    NULL::text AS trace_id
  FROM tasks t
  WHERE t.tenant_id = $1::text
    AND t.created_at <= $3::timestamptz
    AND (
      (t.status IN ('completed','rejected','escalated')
       AND COALESCE(t.completed_at, t.escalated_at, t.updated_at) >= $2::timestamptz)
      OR t.status NOT IN ('completed','rejected','escalated')
    )

  UNION ALL

  -- ── Knowledge Intake Run：workMode 固定 intake ──────────────────────────
  SELECT
    'intake-run'::text AS interval_kind,
    r.tenant_id,
    'intake-run:' || r.tenant_id || ':' || r.id AS stable_id,
    'intake'::text AS work_mode,
    'intake:' || r.subscription_id || ':' || r.stage AS label,
    CASE r.status
      WHEN 'queued' THEN 'queued'
      WHEN 'leased' THEN 'running'
      WHEN 'waiting' THEN 'waiting'
      WHEN 'completed' THEN 'completed'
      ELSE 'failed'
    END AS status,
    (EXTRACT(EPOCH FROM r.created_at) * 1000)::bigint AS start_ms,
    CASE
      WHEN r.status IN ('completed','failed','dead-letter') THEN
        (EXTRACT(EPOCH FROM r.updated_at) * 1000)::bigint
      ELSE NULL
    END AS end_ms,
    to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS source_version,
    NULL::text AS job_id,
    NULL::text AS task_id,
    r.id AS run_id,
    r.stage AS stage,
    r.attempt AS attempt,
    NULL::text AS worker_id,
    NULL::text AS role_id,
    NULL::text AS batch_id,
    NULL::text AS trace_id
  FROM knowledge_intake_runs r
  WHERE r.tenant_id = $1::text
    AND r.created_at <= $3::timestamptz
    AND (
      (r.status IN ('completed','failed','dead-letter') AND r.updated_at >= $2::timestamptz)
      OR r.status NOT IN ('completed','failed','dead-letter')
    )

  UNION ALL

  -- ── Knowledge Intake Stage（attempt 聚合）：同一 attempt identity 一条区间 ──
  SELECT
    'intake-stage'::text AS interval_kind,
    s.tenant_id,
    'intake-stage:' || s.tenant_id || ':' || s.run_id || ':' || s.stage || ':' || s.attempt || ':' || s.lease_generation AS stable_id,
    'intake'::text AS work_mode,
    'intake-stage:' || s.stage AS label,
    CASE
      WHEN s.result_disposition = 'succeeded' THEN 'completed'
      WHEN s.result_disposition = 'retryable-failed' THEN 'retrying'
      WHEN s.result_disposition IS NOT NULL THEN 'failed'
      ELSE 'running'
    END AS status,
    (EXTRACT(EPOCH FROM s.start_ts) * 1000)::bigint AS start_ms,
    CASE WHEN s.end_ts IS NOT NULL THEN (EXTRACT(EPOCH FROM s.end_ts) * 1000)::bigint ELSE NULL END AS end_ms,
    to_char(COALESCE(s.end_ts, s.start_ts) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS source_version,
    NULL::text AS job_id,
    NULL::text AS task_id,
    s.run_id AS run_id,
    s.stage AS stage,
    s.attempt AS attempt,
    NULL::text AS worker_id,
    NULL::text AS role_id,
    NULL::text AS batch_id,
    NULL::text AS trace_id
  FROM (
    SELECT
      a.tenant_id,
      a.run_id,
      a.stage,
      a.attempt,
      a.lease_generation,
      COALESCE(
        MIN(a.created_at) FILTER (WHERE a.disposition = 'leased'),
        MIN(a.created_at)
      ) AS start_ts,
      MIN(a.created_at) FILTER (
        WHERE a.disposition IN ('succeeded','retryable-failed','terminal-failed','expired')
      ) AS end_ts,
      MIN(a.disposition) FILTER (
        WHERE a.disposition IN ('succeeded','retryable-failed','terminal-failed','expired')
      ) AS result_disposition
    FROM knowledge_intake_attempts a
    WHERE a.tenant_id = $1::text
    GROUP BY a.tenant_id, a.run_id, a.stage, a.attempt, a.lease_generation
    HAVING COALESCE(
        MIN(a.created_at) FILTER (WHERE a.disposition = 'leased'),
        MIN(a.created_at)
      ) <= $3::timestamptz
      AND (
        MIN(a.created_at) FILTER (
          WHERE a.disposition IN ('succeeded','retryable-failed','terminal-failed','expired')
        ) IS NULL
        OR MIN(a.created_at) FILTER (
          WHERE a.disposition IN ('succeeded','retryable-failed','terminal-failed','expired')
        ) >= $2::timestamptz
      )
  ) s
) tl
WHERE ($4::text[] IS NULL OR tl.work_mode = ANY($4::text[]))
  AND ($5::text[] IS NULL OR tl.interval_kind = ANY($5::text[]))
  AND ($6::text[] IS NULL OR tl.status = ANY($6::text[]))
  AND ($7::float8 IS NULL OR (tl.start_ms::float8, tl.source_version, tl.stable_id) > ($7::float8, $8::text, $9::text))
ORDER BY tl.start_ms::float8 ASC, tl.source_version ASC, tl.stable_id ASC
LIMIT $10::int
`;

export const RUNTIME_TIMELINE_MODE_FILTERS = RUNTIME_WORK_MODE_FILTERS;
