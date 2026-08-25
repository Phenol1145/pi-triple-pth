/**
 * memory-store-row-mappers.ts —— PgMemoryStore 行映射纯函数。
 *
 * 从 `memory-store-pg.ts` 非破坏性拆分：DB 行 → MemoryRevision / MemoryEntry 的映射集中于此。
 */
import * as MS from "./memory-store-support.js";

/** 列 → MS.MemoryRevision。 */
export function mapRevision(row: any): MS.MemoryRevision {
  return {
    entryId: row.entry_id,
    tenantId: row.tenant_id ?? MS.DEFAULT_TENANT_ID,
    revision: row.revision,
    content: row.content,
    status: row.status,
    anchors: row.anchors ?? [],
    meta: row.meta ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ""),
    createdBy: row.created_by ?? undefined,
    reason: row.reason ?? undefined,
  };
}

/** 列 → MS.MemoryEntry：hit_count/version/not_write_back 从独立列并入 meta（保持接口兼容）。 */
export function mapEntry(row: any): MS.MemoryEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id ?? undefined,
    kind: row.kind,
    anchors: row.anchors,
    content: row.content,
    ruleRef: row.rule_ref ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    status: row.status,
    ttlExpiresAt: row.ttl_expires_at !== null && row.ttl_expires_at !== undefined ? new Date(row.ttl_expires_at).getTime() : undefined,
    promotedFrom: row.promoted_from ?? undefined,
    meta: { ...(row.meta ?? {}), version: row.version, hitCount: row.hit_count, notWriteBack: row.not_write_back },
  };
}
