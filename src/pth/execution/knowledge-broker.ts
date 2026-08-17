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

/** queryText 大小写不敏感子串过滤：content 或 anchors 命中任一空白分词；无词命中 → 返回全部（保守不误杀）。 */
export function filterKnowledgeEntriesByQueryText(
  entries: KnowledgeMemoryEntry[],
  queryText: string | undefined,
): KnowledgeMemoryEntry[] {
  const query = queryText?.trim() ?? "";
  if (query === "") return entries;

  const tokens = query.split(/\s+/).map((t) => t.toLowerCase());
  if (tokens.length === 0) return entries;

  const matched = entries.filter((entry) => {
    const content = entry.content.toLowerCase();
    const anchors = entry.anchors.map((a) => a.toLowerCase());
    return tokens.some((token) => content.includes(token) || anchors.some((a) => a.includes(token)));
  });

  return matched.length > 0 ? matched : entries;
}

/**
 * search 的 retrieve 兜底实现（也供生产 adapter 注入——保持单一实现）：
 * retrieve（anchors/kinds/status/tenant）→ queryText 过滤 → id 升序 → limit 截断。
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
  filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return filtered.slice(0, normalizeKnowledgeSearchLimit(opts.limit));
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
        const rows = (await deps.dataWorld.queryReadOnly(String(request.sql ?? ""))) as Array<Record<string, unknown> | null>;
        if (rows.some((r) => !r || typeof r !== "object" || !("meta" in r))) {
          return { ok: false, status: 400, error: "knowledge query: 必须包含 meta 列（可见性过滤依据）" };
        }
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
