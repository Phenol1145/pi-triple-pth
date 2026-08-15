import type pg from "pg";
import { PgTaskStore, type TaskStore } from "./task-store-pg.js";
import { PgMemoryStore, runReadOnlyQuery, TRUSTED_TEMPLATE_TABLES } from "@away_from/pth-memory";
import { PgTranscriptStore } from "./transcript-store.js";
import { PgAuditStore } from "./audit-store.js";
export {
  READONLY_TABLES,
  TRUSTED_TEMPLATE_TABLES,
  buildReadOnlyQuery,
  runReadOnlyQuery,
} from "@away_from/pth-memory";

/**
 * DataWorldAccess —— PTH postgres 数据世界统一出口（Spec A/B 消费）。
 * tasks/memory/transcripts/audit 四类访问器共享同一 pg 连接池。
 */
export interface DataWorldAccess {
  tasks: TaskStore;
  memory: PgMemoryStore;
  transcripts: PgTranscriptStore;
  audit: PgAuditStore;
  /** 受限只读 SQL（memory.query 能力/agent 工具用）：仅 SELECT 单条语句 + 强制 LIMIT */
  queryReadOnly(sql: string): Promise<unknown>;
  /** 受信模板通道（2026-08-14 A2 Phase 4——obs 工具专用）：固定 SQL 模板 + 参数白名单，
   *  开放 tasks/transcripts 只读面——与 queryReadOnly 的 memory-only 面分开（非 LLM 输入面） */
  queryTemplate(sql: string): Promise<unknown>;
  /** PG 系统视图（obs.pg——2026-08-12 管理 SDK）：固定 SQL 模板白名单——无用户 SQL 注入面 */
  pgStat(view: "activity" | "database" | "bgwriter" | "slow"): Promise<unknown>;
}

export function createDataWorld(pool: pg.Pool, routing?: import("./task-store-pg.js").TaskRouting): DataWorldAccess {
  return {
    tasks: new PgTaskStore(pool, routing),
    memory: new PgMemoryStore(pool),
    transcripts: new PgTranscriptStore(pool),
    audit: new PgAuditStore(pool),
    queryReadOnly: (sql: string) => runReadOnlyQuery(pool, sql),
    queryTemplate: (sql: string) => runReadOnlyQuery(pool, sql, TRUSTED_TEMPLATE_TABLES),
    pgStat: (view) => runReadOnlyPgView(pool, view),
  };
}

/** PG 系统视图白名单（obs.pg——2026-08-12 管理 SDK sensor 面）。
 * 固定 SQL 模板（非用户输入）——观测连接数/缓存命中/后台写。 */
const PG_STAT_VIEWS: Record<"activity" | "database" | "bgwriter" | "slow", string> = {
  activity: `SELECT state, wait_event_type, count(*) AS n
    FROM pg_stat_activity WHERE datname = current_database() GROUP BY state, wait_event_type ORDER BY n DESC LIMIT 20`,
  database: `SELECT datname, numbackends, xact_commit, xact_rollback, blks_read, blks_hit,
    round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS cache_hit_pct
    FROM pg_stat_database WHERE datname = current_database()`,
  bgwriter: `SELECT checkpoints_timed, checkpoints_req, buffers_checkpoint, buffers_clean, maxwritten_clean
    FROM pg_stat_bgwriter`,
  // N5 资源环：长运行/慢查询观测（active >5s——sensor:resource 数据源）
  slow: `SELECT pid, state, now() - query_start AS elapsed, left(query, 200) AS query
    FROM pg_stat_activity
    WHERE datname = current_database() AND state = 'active' AND query_start IS NOT NULL
      AND now() - query_start > interval '5 seconds'
    ORDER BY query_start LIMIT 20`,
};

export async function runReadOnlyPgView(pool: pg.Pool, view: "activity" | "database" | "bgwriter" | "slow"): Promise<unknown> {
  const sql = PG_STAT_VIEWS[view];
  if (!sql) throw new Error(`pgStat: 未知视图 "${String(view)}"（activity/database/bgwriter/slow）`);
  const res = await pool.query(sql);
  return res.rows;
}

// --- barrel：存储层统一出口 ---
// 命名冲突核查（Task 6 引入点）：pg.ts(PgPoolOptions/createPgPool/withTx)、schema.ts(SCHEMA_VERSION/
// SCHEMA_SQL/applySchema)、task-store-pg.ts(Task/PublishInput/TaskStore/PgTaskStore)、memory-store-pg.ts
// (MemoryEntry/PgMemoryStore)、transcript-store.ts(PgTranscriptStore)、audit-store.ts(AuditEvent/PgAuditStore)
// —— 全部唯一，无重名导出。
// 会话平面（2026-08-14 A2 Phase 1——双 storage 层归并：src/pth/storage 迁入 session/）。
// 只 re-export 协议面（接口+类型）；Redis 实现由消费方直引文件（main 装配点）。
export * from "./pg.js";
export * from "./schema.js";
export * from "./task-store-pg.js";
export * from "@away_from/pth-memory";
export * from "./transcript-store.js";
export * from "./audit-store.js";
export type { SessionStore, SettingsStore, CredentialProvider } from "./session/interfaces.js";
export type { SessionMeta, SessionEntry, Snapshot, VersionSnapshotRecord, Settings } from "./session/types.js";
