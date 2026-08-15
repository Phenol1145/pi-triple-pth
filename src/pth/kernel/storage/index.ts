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
  /** 受信模板通道（2026-08-14 A2 Phase 4——obs 工具专用）：固定 SQL 模板 + 参数白名单，
   *  开放 tasks/transcripts 只读面——与 queryReadOnly 的 memory-only 面分开（非 LLM 输入面） */
  queryTemplate(sql: string): Promise<unknown>;
  /** PG 系统视图（obs.pg——2026-08-12 管理 SDK）：固定 SQL 模板白名单——无用户 SQL 注入面 */
  pgStat(view: "activity" | "database" | "bgwriter"): Promise<unknown>;
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

/**
 * 受限只读 SQL 执行器（memory.query 能力 / agent 查询——LLM/任务代码输入不可信）：
 * ① 仅 SELECT（前缀校验，大小写不敏感）② 单条语句（禁分号注入）③ 强制 LIMIT（无则 50，显式上限 200）
 * ④ 禁 pg_catalog/pg_* 系统表探测。
 * ⑤ 表白名单（权限 v2 R2——2026-08-10）：仅 memory_entries 开放——
 *    tasks/transcripts/audit_log/credit_tx 等业务表不开放（任务面走 obs.tasks / 事件检索走 obs.search）。
 */
/** 开放表（worker 查询面——拓扑收敛：记忆库单节点） */
export const READONLY_TABLES = new Set(["memory_entries"]);

/** 受信模板表（2026-08-14 A2 Phase 4）：obs 工具专用通道——固定 SQL 模板 + 参数白名单校验
 *  （非 LLM 自由输入），开放任务/转录只读面。与 memory.query 的 memory-only 面分开——
 *  修复探查缺陷 0.4（obs.tasks/obs.search 此前被 memory-only 白名单误拒，错误文案自相矛盾）。 */
export const TRUSTED_TEMPLATE_TABLES = new Set(["memory_entries", "tasks", "transcripts"]);

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

/**
 * 噪声掩码（与 stripSqlNoise 同规则但**保持长度**）：字符串/注释/dollar-quote 内容 → 空格。
 * 用途：LIMIT 检测必须作用于真实代码位置——否则 `-- limit 999` 或 'limit 999' 会被误认为已有 LIMIT
 * （2026-08-15 筛查 H2）。
 */
function maskSqlNoise(sql: string): string {
  const out = sql.split("");
  let i = 0;
  const fill = (from: number, to: number) => { for (let k = from; k < to; k++) out[k] = " "; };
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      const start = i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      fill(start, i);
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const start = i;
      while (i < sql.length && sql[i] !== "\n") i++;
      fill(start, i);
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < sql.length - 1 && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(sql.length, i + 2);
      fill(start, i);
      continue;
    }
    if (ch === "$") {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_$]*\$|\$)/)?.[0];
      if (tag) {
        const start = i;
        const end = sql.indexOf(tag, i + tag.length);
        i = end >= 0 ? end + tag.length : sql.length;
        fill(start, i);
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

export function buildReadOnlyQuery(sql: string, allowedTables: ReadonlySet<string> = READONLY_TABLES): string {
  const trimmed = sql.trim();
  if (!/^select\b/i.test(trimmed)) throw new Error("queryReadOnly: 仅允许 SELECT 查询（read-only）");
  if (trimmed.includes(";")) throw new Error("queryReadOnly: 仅允许单条语句（single statement only）");
  if (/\bpg_catalog\b|\bpg_\w+\b/i.test(trimmed)) throw new Error("queryReadOnly: 禁止访问 pg 系统表");
  const clean = stripSqlNoise(trimmed);
  const masked = maskSqlNoise(trimmed);
  // 有副作用的 SELECT（序列推进/大对象导入/行锁/SELECT INTO）不是只读（2026-08-15 筛查 M1）
  if (/\b(?:nextval|setval|lo_import|lo_export|dblink|dblink_exec)\s*\(/i.test(masked)) {
    throw new Error("queryReadOnly: 禁止调用有副作用的函数（nextval/setval/lo_* 等）");
  }
  if (/\bfor\s+(?:update|share)\b/i.test(masked)) throw new Error("queryReadOnly: 禁止 FOR UPDATE/FOR SHARE 行锁");
  if (/\binto\b/i.test(masked)) throw new Error("queryReadOnly: 禁止 SELECT INTO");
  // 逗号连表 / TABLE 子句是表名白名单的旁路（2026-08-15 筛查 H1）——仅支持单表 memory_entries
  if (/\b(?:from|join)\s+[a-zA-Z_][\w$.]*(?:\s+(?:as\s+)?[a-zA-Z_][\w$]*)?\s*,/i.test(clean)) {
    throw new Error("queryReadOnly: 逗号连表不开放（仅支持单表 FROM memory_entries）");
  }
  if (/\btable\s+[a-zA-Z_][\w$.]*/i.test(clean)) {
    throw new Error("queryReadOnly: TABLE 子句不开放（仅支持 FROM memory_entries）");
  }
  for (const t of extractTables(trimmed)) {
    if (!allowedTables.has(t)) {
      throw new Error(`queryReadOnly: 表 "${t}" 不开放（开放表: ${[...allowedTables].join(", ")}——任务面请用 obs.tasks / 事件检索请用 obs.search）`);
    }
  }
  // LIMIT 只看掩码后的真实代码；无论原 SQL 是否有 LIMIT，统一外层再包一次强制封顶
  // （内层 LIMIT 不会被误用——外层 n 以真实 LIMIT 解析值封顶，假 LIMIT 按无 LIMIT 处理）。
  const realLimit = masked.match(/\blimit\s+(\d+)\b/i);
  const n = Math.min(Number(realLimit?.[1] ?? 50) || 50, 200);
  return `SELECT * FROM (${trimmed}) _pth_q LIMIT ${n}`;
}

export async function runReadOnlyQuery(pool: pg.Pool, sql: string, allowedTables?: ReadonlySet<string>): Promise<unknown> {
  const safe = buildReadOnlyQuery(sql, allowedTables);
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
// 会话平面（2026-08-14 A2 Phase 1——双 storage 层归并：src/pth/storage 迁入 session/）。
// 只 re-export 协议面（接口+类型）；Redis 实现由消费方直引文件（main 装配点）。
export * from "./pg.js";
export * from "./schema.js";
export * from "./task-store-pg.js";
export * from "./memory-store-pg.js";
export * from "./transcript-store.js";
export * from "./audit-store.js";
export type { SessionStore, SettingsStore, CredentialProvider } from "./session/interfaces.js";
export type { SessionMeta, SessionEntry, Snapshot, VersionSnapshotRecord, Settings } from "./session/types.js";
