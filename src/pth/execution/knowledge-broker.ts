/**
 * execution/knowledge-broker.ts — grant-bound 执行期知识访问（模块化 v2 P2-5）。
 *
 * 规则：
 *  - 每次访问必须携带签名 grant，且 capabilities 含 "memory.read"；
 *  - 可见空间只能来自 grant.scope.space（服务器端签入）；请求体自报 space 被忽略；
 *  - grant 过期/签名无效/无 space → 403 fail-closed；
 *  - query 必须返回 meta 列，否则 400（H3 可见性过滤依据）。
 */

import type { ExecutionGrant } from "../contracts/index.js";
import type { ExecutionGrantService } from "./authorization/execution-grant-service.js";
import { ancestorChain } from "@away_from/pth-memory";
import { filterKnowledgeEntriesByQueryText, rankKnowledgeEntries } from "./knowledge-ranking.js";
import { computeKnowledgeQueryFingerprint } from "../runner/index.js";

export type KnowledgeOp = "query" | "retrieve" | "get" | "search";

export interface KnowledgeRequest {
  grant: ExecutionGrant;
  op: KnowledgeOp;
  sql?: string;
  anchors?: string[];
  kinds?: string[];
  id?: string;
  /** search：queryText（大小写不敏感子串过滤；非空时生效） */
  queryText?: string;
  /** search：检索 anchors（缺省 []） */
  domains?: string[];
  /** search：返回上限（缺省 8，≤20） */
  limit?: number;
  /** 调用方自报 space——本层一律忽略（不可授权） */
  space?: string;
}

export interface KnowledgeMemoryEntry {
  id: string;
  kind: string;
  anchors: string[];
  status: string;
  content: string;
  meta?: Record<string, unknown>;
}

export interface KnowledgeSearchOpts {
  anchors?: string[];
  kinds?: string[];
  status?: string[];
  tenantId?: string;
  queryText?: string;
  limit?: number;
}

export interface KnowledgeBrokerDeps {
  grantService: ExecutionGrantService;
  dataWorld: {
    queryReadOnly(sql: string): Promise<unknown>;
    memory: {
      retrieve(opts: { anchors?: string[]; kinds?: string[]; status?: string[]; tenantId?: string }): Promise<KnowledgeMemoryEntry[]>;
      get(id: string, opts?: { tenantId?: string }): Promise<KnowledgeMemoryEntry | undefined>;
      /** K3 search 窄口（未注入时 broker 用 retrieve + queryText 过滤兜底）。 */
      search?(opts: KnowledgeSearchOpts): Promise<KnowledgeMemoryEntry[]>;
    };
  };
  isVisible(meta: Record<string, unknown> | undefined, space: string): boolean;
  /** K1a：全文 consumption 计数（get 命中后回调）——列表 exposure（retrieve）不计数。 */
  recordConsumption?(id: string, tenantId?: string): Promise<void>;
}

export type KnowledgeResult =
  | { ok: true; rows?: unknown; entries?: unknown[]; entry?: unknown; queryFingerprint?: string }
  | { ok: false; status: 401 | 403 | 404 | 400; error: string };

export const KNOWLEDGE_SEARCH_KINDS = ["domain-fact", "domain-method", "skill", "task-insight"] as const;
export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 8;
export const KNOWLEDGE_SEARCH_MAX_LIMIT = 20;

/** search 有界 limit：缺省 8；显式值截到 [0,20]（负数/NaN → 缺省 8）。 */
export function normalizeKnowledgeSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return KNOWLEDGE_SEARCH_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 0) return KNOWLEDGE_SEARCH_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), KNOWLEDGE_SEARCH_MAX_LIMIT);
}

// ── P0-2（R2）：raw query 数据面强制 tenant/status/space ──────────────────────
// 选型：受限查询 AST（§4.1-a）。服务端解析 caller SQL 后，把 server 谓词注入原 WHERE
// （或补 WHERE），再交给 queryReadOnly 执行；caller 原文 SQL 不作为 queryReadOnly 的直接入参。

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 与 pth-memory maskSqlNoise 同构的长度保持噪声掩码：字符串/标识符/注释/dollar-quote → 空格。 */
function maskSqlNoise(sql: string): string {
  const out = sql.split("");
  const fill = (from: number, to: number) => {
    for (let k = from; k < to; k++) out[k] = " ";
  };
  let i = 0;
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
    if (ch === '"') {
      const start = i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
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

const RESTRICTED_QUERY_FORBIDDEN_RE =
  /\b(?:join|with|union|intersect|except|insert|update|delete|drop|alter|create|truncate|copy|call|do|vacuum|analyze|reindex|grant|revoke|prepare|execute|declare|fetch|move|lock|notify|listen|unlisten|checkpoint|discard)\b/i;

const QUERY_CLAUSE_RES = [
  /\bgroup\s+by\b/i,
  /\bhaving\b/i,
  /\border\s+by\b/i,
  /\blimit\b/i,
  /\boffset\b/i,
  /\bfor\s+update\b/i,
  /\bfor\s+share\b/i,
] as const;

/** 返回 from 之后第一个 GROUP BY/HAVING/ORDER BY/LIMIT/OFFSET/FOR 子句位置（无则 sql.length）。 */
function firstClauseIndex(masked: string, from: number): number {
  let idx = masked.length;
  for (const re of QUERY_CLAUSE_RES) {
    const m = re.exec(masked);
    if (m && m.index >= from && m.index < idx) idx = m.index;
  }
  return idx;
}

/** SQL 谓词必须与 isVisible(meta, space) 同语义：private=仅本空间；public=当前空间是 scope.space 的后代或自身；存量无声明/畸形 scope=meta+public。 */
function buildSpacePredicate(space: string): string {
  const ancestors = ancestorChain(space);
  const ancestorList = ancestors.map(sqlLiteral).join(", ");
  return `(meta IS NULL OR NOT (meta ? 'spaceScope') OR (meta->'spaceScope'->>'space') IS NULL OR COALESCE(meta->'spaceScope'->>'visibility','') NOT IN ('private','public') OR (meta->'spaceScope'->>'visibility' = 'private' AND meta->'spaceScope'->>'space' = ${sqlLiteral(space)}) OR (meta->'spaceScope'->>'visibility' = 'public' AND meta->'spaceScope'->>'space' = ANY(ARRAY[${ancestorList}]::text[])))`;
}

export type RestrictedKnowledgeQueryResult =
  | { ok: true; sql: string }
  | { ok: false; status: 400; error: string };

/**
 * 受限查询 AST：单条 SELECT、单表 memory_entries、无 JOIN/子查询/写操作；
 * 把 tenant_id / status='official' / space 谓词注入原 SQL 的 WHERE 子句。
 * 调用方原文 SQL 不得作为 queryReadOnly 的直接入参——本函数返回 server 改写后的 SQL。
 */
export function buildRestrictedKnowledgeQuery(sql: string, tenantId: string, space: string): RestrictedKnowledgeQueryResult {
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, status: 400, error: "knowledge query: SQL required" };
  if (!/^select\b/i.test(trimmed)) return { ok: false, status: 400, error: "knowledge query: 仅允许 SELECT（read-only）" };
  if (trimmed.includes(";")) return { ok: false, status: 400, error: "knowledge query: 仅允许单条语句（single statement only）" };

  const masked = maskSqlNoise(trimmed);
  if (RESTRICTED_QUERY_FORBIDDEN_RE.test(masked)) {
    return { ok: false, status: 400, error: "knowledge query: 不开放 JOIN/子查询/写操作（仅单表 SELECT FROM memory_entries）" };
  }
  const from = /\bfrom\s+([a-zA-Z_][\w]*)/i.exec(masked);
  if (!from) return { ok: false, status: 400, error: "knowledge query: 仅支持单表 FROM memory_entries" };
  if (from[1]!.toLowerCase() !== "memory_entries") {
    return { ok: false, status: 400, error: `knowledge query: 表 "${from[1]}" 不开放（仅 memory_entries）` };
  }
  const fromEnd = from.index + from[0].length;

  // FROM 区域（FROM 表名之后、WHERE/第一个尾部子句之前）只允许空白或 [AS] alias——
  // 逗号、第二张表、TABLESAMPLE/LATERAL/子查询等复杂表表达式一律 400（逗号跨表数据面漏洞）。
  const where = /\bwhere\b/i.exec(masked);
  const fromRegionEnd = where ? where.index : firstClauseIndex(masked, fromEnd);
  const fromRegion = masked.slice(fromEnd, fromRegionEnd);
  if (!/^\s*(?:AS\s+[A-Za-z_][A-Za-z0-9_$]*|[A-Za-z_][A-Za-z0-9_$]*)?\s*$/i.test(fromRegion)) {
    return { ok: false, status: 400, error: "knowledge query: FROM 仅支持单表 memory_entries（可带表别名），逗号/额外表/表表达式一律 400" };
  }

  const selectCount = (masked.match(/\bselect\b/gi) ?? []).length;
  if (selectCount !== 1) return { ok: false, status: 400, error: "knowledge query: 子查询不开放（仅单层 SELECT FROM memory_entries）" };

  // 可见性判定依据：SELECT * 或显式 meta 列。
  const selectBody = masked.match(/^select\b([\s\S]*?)\bfrom\b/i)?.[1] ?? "";
  if (!/^\s*\*/.test(selectBody) && !/\bmeta\b/i.test(selectBody)) {
    return { ok: false, status: 400, error: "knowledge query: 必须包含 meta 列（可见性谓词依据）" };
  }
  // 列白名单的工程化取舍：全列白名单会严重削弱诊断价值（COUNT/聚合/left() 预览等全部不可用），
  // 故至少禁止 SELECT 列表中的函数调用/表达式——掩码后出现 "(" 即拒（fail-closed）。
  if (selectBody.includes("(")) {
    return { ok: false, status: 400, error: "knowledge query: SELECT 列表禁止函数调用/表达式（仅列名/别名，可用 DISTINCT）" };
  }

  const preds = `(tenant_id = ${sqlLiteral(tenantId)} AND status = 'official' AND ${buildSpacePredicate(space)})`;
  let built: string;
  if (where) {
    const whereEnd = where.index + where[0].length;
    const clauseIdx = firstClauseIndex(masked, whereEnd);
    // 原条件末尾可能是行注释：先换行再闭括号，避免闭括号/后续谓词被注释吞掉。
    built = `${trimmed.slice(0, whereEnd)} (${preds}) AND (${trimmed.slice(whereEnd, clauseIdx)}\n)\n${trimmed.slice(clauseIdx)}`;
  } else {
    const clauseIdx = firstClauseIndex(masked, fromEnd);
    // 无 WHERE：在原 SQL 第一个尾部子句前（或末尾）插入 WHERE；换行保证尾部行注释不会吞掉谓词。
    built = `${trimmed.slice(0, clauseIdx)}\nWHERE ${preds} ${trimmed.slice(clauseIdx)}`;
  }
  return { ok: true, sql: built };
}

/**
 * search 的 retrieve 兜底实现（也供生产 adapter 注入——保持单一实现）：
 * retrieve（anchors/kinds/status/tenant）→ queryText 过滤 → rankKnowledgeEntries → limit 截断。
 * 空间可见性过滤由 broker 统一执行（search 窄口不感知 space）。
 */
export async function searchKnowledgeEntries(
  memory: Pick<KnowledgeBrokerDeps["dataWorld"]["memory"], "retrieve">,
  opts: KnowledgeSearchOpts,
): Promise<KnowledgeMemoryEntry[]> {
  const entries = await memory.retrieve({
    anchors: opts.anchors ?? [],
    kinds: opts.kinds ?? [],
    status: opts.status ?? ["official"],
    tenantId: opts.tenantId,
  });
  const filtered = filterKnowledgeEntriesByQueryText(entries, opts.queryText);
  const ranked = rankKnowledgeEntries(filtered, {
    queryText: opts.queryText,
    domains: opts.anchors ?? [],
  });
  return ranked.slice(0, normalizeKnowledgeSearchLimit(opts.limit));
}

export interface KnowledgeBroker {
  query(request: KnowledgeRequest): Promise<KnowledgeResult>;
}

export function createKnowledgeBroker(deps: KnowledgeBrokerDeps): KnowledgeBroker {
  async function authorize(request: KnowledgeRequest): Promise<{ grant: ExecutionGrant; space: string; tenantId: string } | KnowledgeResult> {
    const verified = deps.grantService.verify(request.grant);
    if (!verified.ok) return { ok: false, status: 401, error: verified.error };
    const grant = verified.grant;
    if (!grant.capabilities.includes("memory.read")) {
      return { ok: false, status: 403, error: "grant missing capability: memory.read" };
    }
    // F2（AB-01）raw query 门禁：query 是诊断通道——除 memory.read 外还要求显式 memory.query 能力。
    if (request.op === "query" && !grant.capabilities.includes("memory.query")) {
      return { ok: false, status: 403, error: "grant missing capability: memory.query" };
    }
    const space = grant.scope.space;
    if (!space) return { ok: false, status: 403, error: "grant scope.space missing（knowledge access fail-closed）" };
    const tenantId = grant.scope.tenantId;
    if (!tenantId) return { ok: false, status: 403, error: "grant scope.tenantId missing（knowledge access fail-closed）" };
    return { grant, space, tenantId };
  }

  return {
    async query(request) {
      const auth = await authorize(request);
      if (!("grant" in auth)) return auth as KnowledgeResult;
      const { grant, space, tenantId } = auth;

      if (request.op === "query") {
        // v1.2 K3 收敛：query 为诊断通道，本批保持；常规知识访问走 retrieve/get（official + tenant 隔离）。
        // R2（P0-2）：raw SQL 走受限查询 AST——server 注入 tenant/status/space 谓词后才允许执行。
        const restricted = buildRestrictedKnowledgeQuery(String(request.sql ?? ""), tenantId, space);
        if (!restricted.ok) return { ok: false, status: restricted.status, error: restricted.error };
        let rows: Array<Record<string, unknown> | null>;
        try {
          rows = (await deps.dataWorld.queryReadOnly(restricted.sql)) as Array<Record<string, unknown> | null>;
        } catch (err) {
          return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) };
        }
        if (rows.some((r) => !r || typeof r !== "object" || !("meta" in r))) {
          return { ok: false, status: 400, error: "knowledge query: 必须包含 meta 列（可见性过滤依据）" };
        }
        // JS 过滤与 SQL 谓词双跑对账（同一 isVisible 语义）；数据面已由注入谓词强制，不依赖本行兜底。
        return { ok: true, rows: rows.filter((r) => deps.isVisible(r!["meta"] as Record<string, unknown>, space)) };
      }
      if (request.op === "retrieve") {
        // 常规检索 official-only：draft/archived 不回给 worker；tenant 来自 grant.scope.tenantId（不可自报）。
        const entries = await deps.dataWorld.memory.retrieve({ anchors: request.anchors ?? [], kinds: request.kinds ?? [], status: ["official"], tenantId });
        return { ok: true, entries: entries.filter((e) => deps.isVisible(e.meta, space)) };
      }
      if (request.op === "search") {
        // K3 窄 search：tenant 不可自报（来自 grant）；status 固定 official；
        // anchors=request.domains；kinds 缺省知识上下文四类；queryText 过滤 + id 升序 + limit 由
        // 注入 search 或 retrieve 兜底实现（searchKnowledgeEntries）保证；space 过滤统一在本层收口。
        const domains = Array.isArray(request.domains)
          ? request.domains.filter((d): d is string => typeof d === "string")
          : [];
        const kinds = request.kinds ?? [...KNOWLEDGE_SEARCH_KINDS];
        const limit = normalizeKnowledgeSearchLimit(request.limit);
        const opts: KnowledgeSearchOpts = {
          anchors: domains,
          kinds,
          status: ["official"],
          tenantId,
          queryText: request.queryText,
          limit,
        };
        const entries = deps.dataWorld.memory.search
          ? await deps.dataWorld.memory.search(opts)
          : await searchKnowledgeEntries(deps.dataWorld.memory, opts);
        const visible = entries.filter((e) => deps.isVisible(e.meta, space));
        return {
          ok: true,
          entries: visible,
          // 同 §1 指纹函数：search 无独立 role/title/text/catalog，以 grant 主体 + queryText/kinds 映射，
          // 保持同一 FNV-1a \n join 形态（可复现、可诊断）。
          queryFingerprint: computeKnowledgeQueryFingerprint({
            tenantId,
            space,
            roleId: grant.scope.principalId ?? "knowledge-search",
            domains,
            title: request.queryText ?? "",
            text: [...kinds].sort().join("\n"),
            catalogVersion: "",
          }),
        };
      }
      if (request.op === "get") {
        const entry = await deps.dataWorld.memory.get(String(request.id ?? ""), { tenantId });
        if (!entry) return { ok: false, status: 404, error: "entry not found" };
        // K3：worker 面只读 official——非 official 一律 404（draft/archived 不进 worker 检索面）。
        if (entry.status !== "official") return { ok: false, status: 404, error: "entry not found" };
        if (!deps.isVisible(entry.meta, space)) return { ok: false, status: 404, error: "entry not visible from space" };
        // 全文 consumption 计数（列表 exposure 不计数）——best-effort 接线由装配方提供。
        await deps.recordConsumption?.(entry.id, tenantId);
        return { ok: true, entry };
      }
      return { ok: false, status: 400, error: "op required: query|retrieve|get|search" };
    },
  };
}
