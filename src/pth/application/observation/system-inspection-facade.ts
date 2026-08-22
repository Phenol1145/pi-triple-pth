/**
 * application/observation/system-inspection-facade.ts — N33 Task 3 只读巡检投影。
 *
 * 约束（plan Task 3 Step 3–5）：
 *  - Memory 列表 SQL 恒带 tenant 谓词 + 可见 status/space 谓词；绝不先全量读出再过滤；
 *  - 分页 fail-closed：limit 默认 20 / 上限 100，越界或畸形 cursor 一律 400；
 *  - MemoryListItem / MemoryRevisionEvent 不携带 tenantId / content / meta 原文；
 *  - Summary 按 canonical MemoryType 聚合 count(*) 与 octet_length(content)；
 *  - WorkerInspection 排除 prompt / content / secret / environment；
 *  - 本文件只有 pool.query / batchManager.listBatches / catalog 读取，绝不写领域源表。
 */

import type pg from "pg";
import { ancestorChain } from "@away_from/pth-memory";
import {
  CONFIG_INSPECTION_MASK,
  emptyMemorySummary,
  SYSTEM_INSPECTION_DEFAULT_LIMIT,
  SYSTEM_INSPECTION_MAX_LIMIT,
  configEntry,
  isWorkMode,
  type ConfigInspectionEntry,
  type ConfigSource,
  type MemoryListItem,
  type MemoryRevisionEvent,
  type MemorySummary,
  type RoleInspection,
  type WorkerInspection,
  type WorkerLifecycle,
} from "@away_from/pth-contracts";
import { PTH_CONFIG_SCHEMA } from "@away_from/pth-config";
import {
  SYSTEM_INSPECTION_MEMORY_ENTRY_SQL,
  SYSTEM_INSPECTION_MEMORY_LIST_SQL,
  SYSTEM_INSPECTION_MEMORY_REVISIONS_SQL,
  SYSTEM_INSPECTION_MEMORY_SUMMARY_SQL,
} from "./system-inspection-sql.js";
import { classifyFeasibilityMemoryType } from "../../execution/index.js";
import { roleDefinitionRevision } from "@away_from/pth-kernel-execution";
import { getRuntimeCatalog } from "../../catalog/index.js";

export const SYSTEM_INSPECTION_MAX_REVISIONS = 10;

export interface SystemInspectionScope {
  tenantId: string;
  space?: string;
}

export interface SystemInspectionMemoryQuery {
  cursor?: string | null;
  limit?: number;
  type?: string;
  kind?: string;
  anchor?: string;
  statuses?: readonly string[];
}

export interface SystemInspectionMemoryPage {
  items: MemoryListItem[];
  nextCursor: string | null;
  scope: { tenantId: string; space?: string };
  collectedAt: number;
}

export interface SystemInspectionConfigCenter {
  explain(key: string): { source: ConfigSource; value: string };
}

export interface SystemInspectionBatchStatus {
  id: string;
  workers: string[];
  currentTasks: Record<string, string>;
  idleRatio?: number;
  health?: string;
  heartbeatLagMs?: number;
  replicas?: Array<{
    workerId: string;
    batchId: string;
    role: { roleId: string; revision: string };
    state: string;
    currentTaskId?: string;
    /** N33 复验收 P1-2：batch 心跳携带的 authoritative 责任区/工作集有界投影。 */
    authoritative?: {
      responsibilities?: Array<{ regionId: string; kind: string; priority: number; regionRevision: number }>;
      regionWeights?: Record<string, number>;
      workingSet?: {
        taskId?: string;
        directorySnapshotId?: string;
        entryIds?: string[];
        skillIndexIds?: string[];
        activeSkillIds?: string[];
        toolNames?: string[];
        counts?: {
          memoryEntries: number; skillIndexEntries: number; activeSkills: number; tools: number;
        };
        usage?: {
          memoryEntries: number; memoryChars: number; skillIndexEntries: number;
          activeSkills: number; skillChars: number; tools: number;
        };
        omitted?: Record<string, number>;
      } | null;
    } | null;
  }>;
}

export interface SystemInspectionBatchManager {
  listBatches(): Promise<SystemInspectionBatchStatus[]>;
}

/** 投影调用非法参数统一 400；路由层直接透传 statusCode。 */
export class SystemInspectionError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "SystemInspectionError";
  }
}

const MEMORY_INSPECTION_STATUSES = ["official", "draft", "archived", "stale"] as const;

/** 与 execution/memory-type-classifier.ts 的 canonical 映射保持一致（SQL 只能消费 kind 白名单）。 */
const MEMORY_TYPE_KINDS: Readonly<Record<string, string[]>> = Object.freeze({
  setting: ["system-setting", "role-definition", "config"],
  wiki: ["domain-fact", "domain-method", "pth-wiki"],
  skill: ["skill", "skill-index"],
  log: ["task-insight", "episodic-log"],
  index: ["source-index", "symbol-index", "memory-collection-index"],
});

const ALL_INSPECTION_KINDS = Object.freeze(
  Object.values(MEMORY_TYPE_KINDS).flatMap((kinds) => kinds),
);

type SqlRow = Record<string, any>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") return [v];
  return [];
}

interface MemoryCursorPayload {
  v: 1;
  tenantId: string;
  updatedAt: string;
  id: string;
}

function encodeMemoryCursor(cursor: MemoryCursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeMemoryCursor(input: string): MemoryCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(input, "base64url").toString("utf8"));
  } catch {
    throw new SystemInspectionError("cursor malformed");
  }
  if (!isRecord(parsed) || parsed.v !== 1) {
    throw new SystemInspectionError("cursor malformed: unknown version");
  }
  const { tenantId, updatedAt, id } = parsed;
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new SystemInspectionError("cursor malformed: tenantId");
  }
  if (typeof updatedAt !== "string" || updatedAt.trim() === "" || Number.isNaN(Date.parse(updatedAt))) {
    throw new SystemInspectionError("cursor malformed: updatedAt");
  }
  if (typeof id !== "string" || id.trim() === "") {
    throw new SystemInspectionError("cursor malformed: id");
  }
  return { v: 1, tenantId, updatedAt, id };
}

function parseStatuses(statuses: readonly string[] | undefined): string[] {
  if (!statuses || statuses.length === 0) return ["official"];
  const out = [...new Set(statuses)];
  for (const status of out) {
    if (!(MEMORY_INSPECTION_STATUSES as readonly string[]).includes(status)) {
      throw new SystemInspectionError(`unknown memory status: ${status}`);
    }
  }
  return out;
}

function parseKinds(type?: string, kind?: string): string[] {
  if (kind !== undefined) {
    if (!isNonEmptyString(kind)) throw new SystemInspectionError("kind must be a non-empty string");
    if (!ALL_INSPECTION_KINDS.includes(kind)) throw new SystemInspectionError(`unknown memory kind: ${kind}`);
    return [kind];
  }
  if (type !== undefined) {
    if (!isNonEmptyString(type)) throw new SystemInspectionError("type must be a non-empty string");
    const kinds = MEMORY_TYPE_KINDS[type];
    if (!kinds) throw new SystemInspectionError(`unknown memory type: ${type}`);
    return [...kinds];
  }
  return [...ALL_INSPECTION_KINDS];
}

function validateScope(scope: SystemInspectionScope): void {
  if (!isRecord(scope) || !isNonEmptyString(scope.tenantId)) {
    throw new SystemInspectionError("scope.tenantId must be a non-empty string (from auth)");
  }
  if (scope.space !== undefined && !isNonEmptyString(scope.space)) {
    throw new SystemInspectionError("scope.space must be a non-empty string when present");
  }
}

function visibleSpacePredicateParams(scope: SystemInspectionScope): { ancestors: string[]; currentSpace: string } {
  const currentSpace = scope.space ?? "meta";
  return { ancestors: ancestorChain(currentSpace), currentSpace };
}

function classifyKind(kind: unknown): ReturnType<typeof classifyFeasibilityMemoryType> {
  if (typeof kind !== "string") return undefined;
  return classifyFeasibilityMemoryType({ kind });
}

function rowToMemoryListItem(row: SqlRow): MemoryListItem | null {
  const memoryType = classifyKind(row.kind);
  if (!memoryType) return null;
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  const updatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
  return {
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status),
    anchors: asStringArray(row.anchors),
    memoryType,
    version: Number(row.version),
    createdAt,
    updatedAt,
    contentBytes: Number(row.content_bytes ?? 0),
  };
}

export class SystemInspectionFacade {
  readonly #pool: pg.Pool;
  readonly #clock: () => number;
  readonly #batchManager: SystemInspectionBatchManager | null;
  readonly #configCenter: SystemInspectionConfigCenter | null;

  constructor(pool: pg.Pool, opts: {
    clock?: () => number;
    batchManager?: SystemInspectionBatchManager | null;
    configCenter?: SystemInspectionConfigCenter | null;
  } = {}) {
    this.#pool = pool;
    this.#clock = opts.clock ?? (() => Date.now());
    this.#batchManager = opts.batchManager ?? null;
    this.#configCenter = opts.configCenter ?? null;
  }

  // ── Memory 列表（SQL-first：tenant + status + space 谓词 + updated_at cursor） ──

  async queryMemory(
    scope: SystemInspectionScope,
    query: SystemInspectionMemoryQuery = {},
  ): Promise<SystemInspectionMemoryPage> {
    validateScope(scope);
    const limit = query.limit ?? SYSTEM_INSPECTION_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > SYSTEM_INSPECTION_MAX_LIMIT) {
      throw new SystemInspectionError(
        `limit must be an integer 1-${SYSTEM_INSPECTION_MAX_LIMIT} (fail-closed)`,
      );
    }

    const statuses = parseStatuses(query.statuses);
    const kinds = parseKinds(query.type, query.kind);
    const anchor = query.anchor === undefined ? null : query.anchor;
    if (anchor !== null && !isNonEmptyString(anchor)) {
      throw new SystemInspectionError("anchor must be a non-empty string");
    }

    const cursor = query.cursor ? decodeMemoryCursor(query.cursor) : null;
    if (cursor && cursor.tenantId !== scope.tenantId) {
      throw new SystemInspectionError("cursor tenant mismatch (fail-closed)");
    }

    const { ancestors, currentSpace } = visibleSpacePredicateParams(scope);
    const params: unknown[] = [
      scope.tenantId,
      statuses,
      kinds,
      anchor ? [anchor] : null,
      ancestors,
      currentSpace,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ];

    const sql = SYSTEM_INSPECTION_MEMORY_LIST_SQL;
    const result = await this.#pool.query<SqlRow>(sql, params);
    const rows = result.rows;

    const mapped: MemoryListItem[] = [];
    for (const row of rows) {
      const item = rowToMemoryListItem(row);
      if (item) mapped.push(item);
    }

    const hasMore = mapped.length > limit;
    const pageRows = hasMore ? mapped.slice(0, limit) : mapped;
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last
      ? encodeMemoryCursor({
          v: 1,
          tenantId: scope.tenantId,
          updatedAt: last.updatedAt,
          id: last.id,
        })
      : null;

    return {
      items: pageRows,
      nextCursor,
      scope: { tenantId: scope.tenantId, ...(scope.space ? { space: scope.space } : {}) },
      collectedAt: this.#clock(),
    };
  }

  // ── Memory 单条（精确 ID + tenant/visibility 谓词） ──

  async queryMemoryEntry(scope: SystemInspectionScope, id: string): Promise<MemoryListItem | null> {
    validateScope(scope);
    if (!isNonEmptyString(id)) throw new SystemInspectionError("entry id must be a non-empty string");
    const { ancestors, currentSpace } = visibleSpacePredicateParams(scope);
    const result = await this.#pool.query<SqlRow>(SYSTEM_INSPECTION_MEMORY_ENTRY_SQL, [
      scope.tenantId,
      id,
      ancestors,
      currentSpace,
    ]);
    const row = result.rows[0];
    return row ? rowToMemoryListItem(row) : null;
  }

  // ── Memory Summary（canonical MemoryType count + octet_length） ──

  async queryMemorySummary(
    scope: SystemInspectionScope,
    query: { statuses?: readonly string[]; type?: string; kind?: string; anchor?: string } = {},
  ): Promise<MemorySummary> {
    validateScope(scope);
    const statuses = parseStatuses(query.statuses);
    const kinds = parseKinds(query.type, query.kind);
    const anchor = query.anchor === undefined ? null : query.anchor;
    if (anchor !== null && !isNonEmptyString(anchor)) {
      throw new SystemInspectionError("anchor must be a non-empty string");
    }
    const { ancestors, currentSpace } = visibleSpacePredicateParams(scope);
    const result = await this.#pool.query<SqlRow>(SYSTEM_INSPECTION_MEMORY_SUMMARY_SQL, [
      scope.tenantId,
      statuses,
      kinds,
      anchor ? [anchor] : null,
      ancestors,
      currentSpace,
    ]);

    const summary = emptyMemorySummary();
    for (const row of result.rows) {
      const memoryType = classifyKind(row.kind);
      if (!memoryType) continue;
      summary.byType[memoryType].count += Number(row.count);
      summary.byType[memoryType].bytes += Number(row.bytes);
    }
    for (const type of Object.keys(summary.byType) as Array<keyof MemorySummary["byType"]>) {
      summary.totals.count += summary.byType[type].count;
      summary.totals.bytes += summary.byType[type].bytes;
    }
    return summary;
  }

  // ── Recent revisions（append-only log + current revision，最新在前） ──

  async queryMemoryRevisions(
    scope: SystemInspectionScope,
    entryId: string,
    limit = SYSTEM_INSPECTION_MAX_REVISIONS,
  ): Promise<MemoryRevisionEvent[]> {
    validateScope(scope);
    if (!isNonEmptyString(entryId)) throw new SystemInspectionError("entryId must be a non-empty string");
    if (!Number.isInteger(limit) || limit < 1 || limit > SYSTEM_INSPECTION_MAX_REVISIONS) {
      throw new SystemInspectionError(`revision limit must be an integer 1-${SYSTEM_INSPECTION_MAX_REVISIONS}`);
    }
    // N33 复验收 P1-1：revision 历史必须先过与 detail 完全相同的 tenant/status/space 可见性门。
    // 条目不可见时返回空历史，而不是按 entryId 猜出 revision/status/createdBy/reason 元数据。
    const { ancestors, currentSpace } = visibleSpacePredicateParams(scope);
    const visible = await this.#pool.query<SqlRow>(SYSTEM_INSPECTION_MEMORY_ENTRY_SQL, [scope.tenantId, entryId, ancestors, currentSpace]);
    if (visible.rows.length === 0) return [];
    const result = await this.#pool.query<SqlRow>(SYSTEM_INSPECTION_MEMORY_REVISIONS_SQL, [scope.tenantId, entryId, limit]);
    return result.rows.slice(0, limit).map((row) => ({
      entryId: String(row.entry_id),
      revision: Number(row.revision),
      status: String(row.status),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      ...(row.created_by !== null && row.created_by !== undefined ? { createdBy: String(row.created_by) } : {}),
      ...(row.reason !== null && row.reason !== undefined ? { reason: String(row.reason) } : {}),
    }));
  }

  // ── Worker 投影（IDs / role revision / lifecycle / task / lease / heartbeat） ──

  async queryWorkers(scope: SystemInspectionScope): Promise<WorkerInspection[]> {
    validateScope(scope);
    if (!this.#batchManager) return [];

    const batches = await this.#batchManager.listBatches();
    const catalog = getRuntimeCatalog();
    const taskIds = new Set<string>();
    for (const batch of batches) {
      for (const taskId of Object.values(batch.currentTasks ?? {})) {
        if (taskId) taskIds.add(taskId);
      }
      for (const replica of batch.replicas ?? []) {
        if (replica.currentTaskId) taskIds.add(replica.currentTaskId);
      }
    }

    const taskRows = taskIds.size > 0
      ? (await this.#pool.query<SqlRow>(
          `SELECT id, work_mode, lease_id::text AS lease_id FROM tasks WHERE tenant_id = $1 AND id = ANY($2::text[])`,
          [scope.tenantId, [...taskIds]],
        )).rows
      : [];
    const taskById = new Map(taskRows.map((row) => [String(row.id), row]));

    const roleRevision = (roleId: string): string | undefined => {
      const role = catalog?.role(roleId);
      if (!role) return undefined;
      return roleDefinitionRevision({
        id: role.id,
        tags: [...role.tags],
        prompt: role.prompt,
        ...(role.capabilities ? { capabilities: [...role.capabilities] } : {}),
        ...(role.thinking ? { thinking: role.thinking } : {}),
        ...(role.description ? { description: role.description } : {}),
        ...(role.acceptanceRole ? { acceptanceRole: role.acceptanceRole } : {}),
        ...(role.parent !== undefined && role.parent !== null ? { parent: role.parent } : {}),
        ...(role.generation !== undefined ? { generation: role.generation } : {}),
      } as never);
    };

    const out: WorkerInspection[] = [];
    for (const batch of batches) {
      const busy = new Set(Object.keys(batch.currentTasks ?? {}));
      const taskOf = (workerId: string | undefined): string | null => {
        if (!workerId) return null;
        return batch.currentTasks?.[workerId] ?? null;
      };

      // feasibility 心跳自报副本（含 workerId / role revision / state）。
      for (const replica of batch.replicas ?? []) {
        const taskId = replica.currentTaskId ?? taskOf(replica.workerId);
        const task = taskId ? taskById.get(taskId) : undefined;
        const authoritative = replica.authoritative ?? null;
        const responsibilities = authoritative?.responsibilities ?? [];
        const working = authoritative?.workingSet ?? null;
        out.push({
          workerId: replica.workerId,
          batchId: replica.batchId || batch.id,
          role: {
            roleId: replica.role.roleId,
            revision: replica.role.revision || roleRevision(replica.role.roleId) || `role-sha256:unavailable:${replica.role.roleId}`,
          },
          lifecycle: (["idle", "busy", "paused", "draining", "stopped"] as readonly string[]).includes(replica.state)
            ? (replica.state as WorkerLifecycle)
            : "unknown",
          workMode: task && isWorkMode(task.work_mode) ? task.work_mode : null,
          currentTaskId: task ? taskId : null,
          leaseId: task?.lease_id ? String(task.lease_id) : null,
          regionIds: responsibilities.map((r) => r.regionId),
          regionWeights: authoritative?.regionWeights ?? {},
          workingSet: {
            entryIds: working?.entryIds ?? [],
            skillIndexIds: working?.skillIndexIds ?? [],
            activeSkillIds: working?.activeSkillIds ?? [],
            counts: working?.counts ?? { memoryEntries: 0, skillIndexEntries: 0, activeSkills: 0, tools: 0 },
            usage: working?.usage ?? { memoryEntries: 0, memoryChars: 0, skillIndexEntries: 0, activeSkills: 0, skillChars: 0, tools: 0 },
            omitted: working?.omitted ?? {},
          },
          toolNames: working?.toolNames ?? [],
          skillIds: working?.skillIndexIds ?? [],
          heartbeatLagMs: typeof batch.heartbeatLagMs === "number" ? batch.heartbeatLagMs : null,
        });
      }

      // legacy 单副本模式（无 worker UUID——按 roleId 投影，ID 用 batchId:roleId 保持稳定）。
      for (const roleId of batch.workers ?? []) {
        if (batch.replicas?.some((replica) => replica.role.roleId === roleId)) continue;
        const taskId = taskOf(roleId);
        const task = taskId ? taskById.get(taskId) : undefined;
        out.push({
          workerId: `${batch.id}:${roleId}`,
          batchId: batch.id,
          role: {
            roleId,
            revision: roleRevision(roleId) ?? `role-sha256:unavailable:${roleId}`,
          },
          lifecycle: busy.has(roleId) ? "busy" : "idle",
          workMode: task && isWorkMode(task.work_mode) ? task.work_mode : null,
          currentTaskId: task ? taskId : null,
          leaseId: task?.lease_id ? String(task.lease_id) : null,
          regionIds: [],
          regionWeights: {},
          workingSet: {
            entryIds: [],
            skillIndexIds: [],
            activeSkillIds: [],
            counts: { memoryEntries: 0, skillIndexEntries: 0, activeSkills: 0, tools: 0 },
            usage: { memoryEntries: 0, memoryChars: 0, skillIndexEntries: 0, activeSkills: 0, skillChars: 0, tools: 0 },
            omitted: {},
          },
          toolNames: [],
          skillIds: [],
          heartbeatLagMs: typeof batch.heartbeatLagMs === "number" ? batch.heartbeatLagMs : null,
        });
      }
    }
    return out;
  }

  // ── Config 投影（schema 定义 + redacted explain） ──

  async queryConfig(): Promise<ConfigInspectionEntry[]> {
    const center = this.#configCenter;
    if (!center) {
      throw new SystemInspectionError("config center unavailable");
    }
    return PTH_CONFIG_SCHEMA.map((def) => {
      const explanation = center.explain(def.key);
      return configEntry({
        key: def.key,
        type: def.type,
        group: def.group,
        scope: def.scope,
        description: def.description,
        secret: def.secret === true,
        runtime: def.runtime === true,
        source: explanation.source,
        effective: explanation.value,
        defaultValue: def.default === null ? "" : String(def.default),
      });
    });
  }

  // ── Role 投影（Runtime Catalog + roleDefinitionRevision） ──

  queryRoles(): RoleInspection[] {
    const catalog = getRuntimeCatalog();
    if (!catalog) return [];
    return catalog.roles().map((role) => ({
      roleId: role.id,
      revision: roleDefinitionRevision({
        id: role.id,
        tags: [...role.tags],
        prompt: role.prompt,
        ...(role.capabilities ? { capabilities: [...role.capabilities] } : {}),
        ...(role.thinking ? { thinking: role.thinking } : {}),
        ...(role.description ? { description: role.description } : {}),
        ...(role.acceptanceRole ? { acceptanceRole: role.acceptanceRole } : {}),
        ...(role.parent !== undefined && role.parent !== null ? { parent: role.parent } : {}),
        ...(role.generation !== undefined ? { generation: role.generation } : {}),
      } as never),
      parent: role.parent ?? null,
      ...(role.generation !== undefined ? { generation: role.generation } : {}),
      tags: [...role.tags],
      ...(role.capabilities ? { capabilities: [...role.capabilities] } : {}),
      thinking: role.thinking ?? null,
      acceptanceRole: role.acceptanceRole ?? null,
      ...(role.description ? { description: role.description } : {}),
    }));
  }
}

export const SYSTEM_INSPECTION_MEMORY_STATUSES = MEMORY_INSPECTION_STATUSES;
export const SYSTEM_INSPECTION_MEMORY_TYPE_KINDS = MEMORY_TYPE_KINDS;
export const SYSTEM_INSPECTION_MASK = CONFIG_INSPECTION_MASK;
