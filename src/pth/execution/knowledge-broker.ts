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

export type KnowledgeOp = "query" | "retrieve" | "get";

export interface KnowledgeRequest {
  grant: ExecutionGrant;
  op: KnowledgeOp;
  sql?: string;
  anchors?: string[];
  kinds?: string[];
  id?: string;
  /** 调用方自报 space——本层一律忽略（不可授权） */
  space?: string;
}

export interface KnowledgeBrokerDeps {
  grantService: ExecutionGrantService;
  dataWorld: {
    queryReadOnly(sql: string): Promise<unknown>;
    memory: {
      retrieve(opts: { anchors?: string[]; kinds?: string[] }): Promise<Array<{ id: string; kind: string; anchors: string[]; status: string; content: string; meta?: Record<string, unknown> }>>;
      get(id: string): Promise<{ id: string; kind: string; anchors: string[]; status: string; content: string; meta?: Record<string, unknown> } | undefined>;
    };
  };
  isVisible(meta: Record<string, unknown> | undefined, space: string): boolean;
}

export type KnowledgeResult =
  | { ok: true; rows?: unknown; entries?: unknown[]; entry?: unknown }
  | { ok: false; status: 401 | 403 | 404 | 400; error: string };

export interface KnowledgeBroker {
  query(request: KnowledgeRequest): Promise<KnowledgeResult>;
}

export function createKnowledgeBroker(deps: KnowledgeBrokerDeps): KnowledgeBroker {
  async function authorize(request: KnowledgeRequest): Promise<{ grant: ExecutionGrant; space: string } | KnowledgeResult> {
    const verified = deps.grantService.verify(request.grant);
    if (!verified.ok) return { ok: false, status: 401, error: verified.error };
    const grant = verified.grant;
    if (!grant.capabilities.includes("memory.read")) {
      return { ok: false, status: 403, error: "grant missing capability: memory.read" };
    }
    const space = grant.scope.space;
    if (!space) return { ok: false, status: 403, error: "grant scope.space missing（knowledge access fail-closed）" };
    return { grant, space };
  }

  return {
    async query(request) {
      const auth = await authorize(request);
      if (!("grant" in auth)) return auth as KnowledgeResult;
      const { space } = auth;

      if (request.op === "query") {
        const rows = (await deps.dataWorld.queryReadOnly(String(request.sql ?? ""))) as Array<Record<string, unknown> | null>;
        if (rows.some((r) => !r || typeof r !== "object" || !("meta" in r))) {
          return { ok: false, status: 400, error: "knowledge query: 必须包含 meta 列（可见性过滤依据）" };
        }
        return { ok: true, rows: rows.filter((r) => deps.isVisible(r!["meta"] as Record<string, unknown>, space)) };
      }
      if (request.op === "retrieve") {
        const entries = await deps.dataWorld.memory.retrieve({ anchors: request.anchors ?? [], kinds: request.kinds ?? [] });
        return { ok: true, entries: entries.filter((e) => deps.isVisible(e.meta, space)) };
      }
      if (request.op === "get") {
        const entry = await deps.dataWorld.memory.get(String(request.id ?? ""));
        if (!entry) return { ok: false, status: 404, error: "entry not found" };
        if (!deps.isVisible(entry.meta, space)) return { ok: false, status: 404, error: "entry not visible from space" };
        return { ok: true, entry };
      }
      return { ok: false, status: 400, error: "op required: query|retrieve|get" };
    },
  };
}
