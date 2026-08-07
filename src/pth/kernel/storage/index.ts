import type pg from "pg";
import { PgTaskStore, type TaskStore } from "./task-store-pg.js";
import { PgMemoryStore } from "./memory-store-pg.js";
import { PgTranscriptStore } from "./transcript-store.js";
import { PgAuditStore } from "./audit-store.js";

/**
 * DataWorldAccess —— PTH postgres 数据世界统一出口（Spec A/B 消费）。
 * tasks/memory/transcripts/audit 四类访问器共享同一 pg 连接池。
 */
export interface DataWorldAccess {
  tasks: TaskStore;
  memory: PgMemoryStore;
  transcripts: PgTranscriptStore;
  audit: PgAuditStore;
}

export function createDataWorld(pool: pg.Pool): DataWorldAccess {
  return {
    tasks: new PgTaskStore(pool),
    memory: new PgMemoryStore(pool),
    transcripts: new PgTranscriptStore(pool),
    audit: new PgAuditStore(pool),
  };
}

// --- barrel：存储层统一出口 ---
// 命名冲突核查（Task 6 引入点）：pg.ts(PgPoolOptions/createPgPool/withTx)、schema.ts(SCHEMA_VERSION/
// SCHEMA_SQL/applySchema)、task-store-pg.ts(Task/PublishInput/TaskStore/PgTaskStore)、memory-store-pg.ts
// (MemoryEntry/PgMemoryStore)、transcript-store.ts(PgTranscriptStore)、audit-store.ts(AuditEvent/PgAuditStore)
// —— 全部唯一，无重名导出。
export * from "./pg.js";
export * from "./schema.js";
export * from "./task-store-pg.js";
export * from "./memory-store-pg.js";
export * from "./transcript-store.js";
export * from "./audit-store.js";
