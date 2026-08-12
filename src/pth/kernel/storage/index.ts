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
  /** 受限只读 SQL（memory.query 能力/agent 工具用）：仅 SELECT 单条语句 + 强制 LIMIT */
  queryReadOnly(sql: string): Promise<unknown>;
  /** PG 系统视图（obs.pg——2026-08-12 管理 SDK）：固定 SQL 模板白名单——无用户 SQL 注入面 */
  pgStat(view: "activity" | "database" | "bgwriter"): Promise<unknown>;
}

export function createDataWorld(pool: pg.Pool): DataWorldAccess {
  return {
    tasks: new PgTaskStore(pool),
    memory: new PgMemoryStore(pool),
    transcripts: new PgTranscriptStore(pool),
    audit: new PgAuditStore(pool),
    queryReadOnly: (sql: string) => runReadOnlyQuery(pool, sql),
    pgStat: (view) => runReadOnlyPgView(pool, view),
  };
}

/**
 * 受限只读 SQL 执行器（memory.query 能力 / agent 查询——LLM/任务代码输入不可信）：
 * ① 仅 SELECT（前缀校验，大小写不敏感）② 单条语句（禁分号注入）③ 强制 LIMIT（无则 50，显式上限 200）
 * ④ 禁 pg_catalog/pg_* 系统表探测。
 * ⑤ 表白名单（权限 v2 R2——2026-08-10）：仅 memory_entries 开放——
 *    tasks/transcripts/audit_log/credit_tx 等业务表不开放（任务面走 obs.tasks / 事件检索走 obs.search）。
 */
/** 开放表（worker 查询面——拓扑收敛：记忆库单节点） */
export const READONLY_TABLES = new Set(["memory_entries"]);

/** 提取 FROM/JOIN 表引用前的噪声剥离：字符串字面量 → 注释 → 引号标识符。
 *  保证：① FROM 后引号标识符不逃逸名单 ② FROM 与表名间插注释分隔不逃逸 ③ 字符串内的 from x 不误捕。 */
function stripSqlNoise(sql: string): string {
  // ① 剥离字符串字面量（含 '' 转义）——防止串内 "from x" 误捕
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'") {
      out += " ";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; } // '' 转义
          out += " ";
          i++;
          break;
        }
        i++;
      }
    } else {
      out += ch;
    }
  }
  // ② 剥离注释（-- 行注释 / /* 块注释）——FROM/*x*/tasks → FROM tasks
  return out
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // ③ 引号标识符 → 裸标识符——FROM "tasks" → FROM tasks
    .replace(/"([^"]+)"/g, "$1");
}

/** 提取 FROM/JOIN 表引用（子查询内层亦命中；schema 前缀剥离；CTE 名会被误捕——保守拒绝可接受） */
function extractTables(sql: string): string[] {
  const out: string[] = [];
  for (const m of stripSqlNoise(sql).matchAll(/\b(?:from|join)\s+([a-zA-Z_][\w.]*)/gi)) {
    out.push(m[1]!.split(".").pop()!);
  }
  return out;
}

export function buildReadOnlyQuery(sql: string): string {
  const trimmed = sql.trim();
  if (!/^select\b/i.test(trimmed)) throw new Error("queryReadOnly: 仅允许 SELECT 查询（read-only）");
  if (trimmed.includes(";")) throw new Error("queryReadOnly: 仅允许单条语句（single statement only）");
  if (/\bpg_catalog\b|\bpg_\w+\b/i.test(trimmed)) throw new Error("queryReadOnly: 禁止访问 pg 系统表");
  for (const t of extractTables(trimmed)) {
    if (!READONLY_TABLES.has(t)) {
      throw new Error(`queryReadOnly: 表 "${t}" 不开放（开放表: ${[...READONLY_TABLES].join(", ")}——任务面请用 obs.tasks / 事件检索请用 obs.search）`);
    }
  }
  if (!/\blimit\s+\d+/i.test(trimmed)) {
    return `${trimmed} LIMIT 50`;
  }
  return trimmed.replace(/\blimit\s+\d+/i, (m) => {
    const n = Math.min(Number(m.replace(/\D/g, "")) || 50, 200);
    return `LIMIT ${n}`;
  });
}

export async function runReadOnlyQuery(pool: pg.Pool, sql: string): Promise<unknown> {
  const safe = buildReadOnlyQuery(sql);
  const res = await pool.query(safe);
  return res.rows;
}

/** PG 系统视图白名单（obs.pg——2026-08-12 管理 SDK sensor 面）。
 * 固定 SQL 模板（非用户输入）——观测连接数/缓存命中/后台写。 */
const PG_STAT_VIEWS: Record<"activity" | "database" | "bgwriter", string> = {
  activity: `SELECT state, wait_event_type, count(*) AS n
    FROM pg_stat_activity WHERE datname = current_database() GROUP BY state, wait_event_type ORDER BY n DESC LIMIT 20`,
  database: `SELECT datname, numbackends, xact_commit, xact_rollback, blks_read, blks_hit,
    round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS cache_hit_pct
    FROM pg_stat_database WHERE datname = current_database()`,
  bgwriter: `SELECT checkpoints_timed, checkpoints_req, buffers_checkpoint, buffers_clean, maxwritten_clean
    FROM pg_stat_bgwriter`,
};

export async function runReadOnlyPgView(pool: pg.Pool, view: "activity" | "database" | "bgwriter"): Promise<unknown> {
  const sql = PG_STAT_VIEWS[view];
  if (!sql) throw new Error(`pgStat: 未知视图 "${String(view)}"（activity/database/bgwriter）`);
  const res = await pool.query(sql);
  return res.rows;
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
