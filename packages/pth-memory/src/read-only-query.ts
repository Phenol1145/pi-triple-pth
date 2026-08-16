/**
 * read-only-query.ts —— 受限只读 SQL 执行器（memory.query 能力 / agent 查询——LLM/任务代码输入不可信）。
 * 2026-08-15 模块拆分：从 src/pth/kernel/storage/index.ts 迁入 pth-memory 包。
 *
 * ① 仅 SELECT（前缀校验，大小写不敏感）② 单条语句（禁分号注入）③ 强制 LIMIT（无则 50，显式上限 200）
 * ④ 禁 pg_catalog/pg_* 系统表探测。
 * ⑤ 表白名单（权限 v2 R2——2026-08-10）：仅 memory_entries 开放——
 *    tasks/transcripts/audit_log/credit_tx 等业务表不开放（任务面走 obs.tasks / 事件检索走 obs.search）。
 * 2026-08-15 筛查加固：逗号连表/TABLE 旁路拒绝；噪声掩码后 LIMIT 检测；有副作用 SELECT 拒绝。
 */
import type pg from "pg";

/** 开放表（worker 查询面——拓扑收敛：记忆库单节点） */
export const READONLY_TABLES = new Set(["memory_entries"]);

/** 受信模板表（2026-08-14 A2 Phase 4）：obs 工具专用通道——固定 SQL 模板 + 参数白名单校验
 *  （非 LLM 自由输入），开放任务/转录只读面。与 memory.query 的 memory-only 面分开。 */
export const TRUSTED_TEMPLATE_TABLES = new Set(["memory_entries", "tasks", "transcripts"]);

/** 提取 FROM/JOIN 表引用前的噪声剥离：字符串字面量 → 注释 → 引号标识符。 */
function stripSqlNoise(sql: string): string {
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
  return out
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
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

/** 噪声掩码（与 stripSqlNoise 同规则但保持长度）：字符串/注释/dollar-quote 内容 → 空格。 */
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

export interface ReadQueryVisibility {
  /** 当前会话空间 */
  currentSpace: string;
  /** 祖先链（含当前空间与 meta）——由装配层 spaceLookup 派生 */
  ancestors: string[];
}

/** H3：会话空间下查询必须投影 meta 列（谓词下推依据；SELECT * 视为包含） */
export function requireMetaColumn(sql: string): void {
  const cleaned = stripSqlNoise(sql.trim());
  const selectBody = cleaned.match(/^select\b([\s\S]*?)\bfrom\b/i)?.[1] ?? "";
  if (!/^\s*\*/.test(selectBody) && !/\bmeta\b/i.test(selectBody)) {
    throw new Error("memory.query: 会话空间下查询必须包含 meta 列（可见性谓词依据）——请 SELECT ..., meta FROM memory_entries ...");
  }
}

export function buildReadOnlyQuery(sql: string, allowedTables: ReadonlySet<string> = READONLY_TABLES, visibility?: ReadQueryVisibility): string {
  const trimmed = sql.trim();
  if (!/^select\b/i.test(trimmed)) throw new Error("queryReadOnly: 仅允许 SELECT 查询（read-only）");
  if (trimmed.includes(";")) throw new Error("queryReadOnly: 仅允许单条语句（single statement only）");
  if (/\bpg_catalog\b|\bpg_\w+\b/i.test(trimmed)) throw new Error("queryReadOnly: 禁止访问 pg 系统表");
  const clean = stripSqlNoise(trimmed);
  const masked = maskSqlNoise(trimmed);
  if (/\b(?:nextval|setval|lo_import|lo_export|dblink|dblink_exec)\s*\(/i.test(masked)) {
    throw new Error("queryReadOnly: 禁止调用有副作用的函数（nextval/setval/lo_* 等）");
  }
  if (/\bfor\s+(?:update|share)\b/i.test(masked)) throw new Error("queryReadOnly: 禁止 FOR UPDATE/FOR SHARE 行锁");
  if (/\binto\b/i.test(masked)) throw new Error("queryReadOnly: 禁止 SELECT INTO");
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
  const realLimit = masked.match(/\blimit\s+(\d+)\b/i);
  const n = Math.min(Number(realLimit?.[1] ?? 50) || 50, 200);
  // H3：可见性谓词下推——private=仅本空间；public=空间 ∈ 祖先链；存量无声明=meta+public
  const where = visibility
    ? ` WHERE (_pth_q.meta IS NULL OR NOT (_pth_q.meta ? 'spaceScope') OR (_pth_q.meta->'spaceScope'->>'visibility' = 'private' AND _pth_q.meta->'spaceScope'->>'space' = $1::text) OR (_pth_q.meta->'spaceScope'->>'visibility' = 'public' AND _pth_q.meta->'spaceScope'->>'space' = ANY($2::text[])))`
    : "";
  return `SELECT * FROM (${trimmed}) _pth_q${where} LIMIT ${n}`;
}

export async function runReadOnlyQuery(
  pool: pg.Pool,
  sql: string,
  allowedTables?: ReadonlySet<string>,
  visibility?: ReadQueryVisibility,
): Promise<unknown> {
  if (visibility) requireMetaColumn(sql);
  const safe = buildReadOnlyQuery(sql, allowedTables, visibility);
  const params = visibility ? [visibility.currentSpace, visibility.ancestors] : [];
  const res = await pool.query(safe, params);
  return res.rows;
}
