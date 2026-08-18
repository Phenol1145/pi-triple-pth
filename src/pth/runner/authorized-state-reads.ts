/**
 * runner/authorized-state-reads.ts —— N28 T5 scope-bound canonical state reads。
 *
 * 每次 store 调用前检查 branded scope 与有效 deadline；固定 tool-function/task-insight
 * kind；生产 isVisible(entry.meta, authorization.space) 谓词；排序后 limit。
 * 稳定 ID：state:function:<entry.id> / state:insight:<entry.id>。
 */

import { assertVerifiedTaskReadScope, type VerifiedTaskReadScope } from "../execution/index.js";

export type CanonicalFunctionRecall = { id: string; key: string; source: string; spec: unknown };
export type CanonicalInsightRecall = { id: string; content: string };

export interface AuthorizedStateReadPort {
  forScope(authorization: VerifiedTaskReadScope): {
    recallFunctions(anchors: string[], opts?: { limit?: number }): Promise<CanonicalFunctionRecall[]>;
    recallInsights(anchors: string[], opts?: { limit?: number }): Promise<CanonicalInsightRecall[]>;
  };
}

export function createAuthorizedStateReadPort(deps: {
  memory: {
    retrieve(opts: { anchors?: string[]; kinds?: string[]; status?: string[]; tenantId?: string }): Promise<Array<{
      id: string;
      kind: string;
      anchors: string[];
      status: string;
      content: string;
      meta?: Record<string, unknown>;
      tenantId?: string;
    }>>;
  };
  isVisible(meta: Record<string, unknown> | undefined, space: string): boolean;
  clock: () => Date;
}): AuthorizedStateReadPort {
  return {
    forScope(authorization) {
      assertVerifiedTaskReadScope(authorization, { capabilities: ["state.recallFunctions", "state.recallInsights"] }, { clock: deps.clock });

      async function load(kind: "tool-function" | "task-insight", anchors: string[], opts?: { limit?: number }): Promise<Array<{ id: string; content: string }>> {
        assertVerifiedTaskReadScope(authorization, {}, { clock: deps.clock });
        const entries = await deps.memory.retrieve({
          anchors: anchors ?? [],
          kinds: [kind],
          status: ["official"],
          tenantId: authorization.tenantId,
        });
        return entries
          .filter((entry) =>
            entry.kind === kind &&
            entry.status === "official" &&
            entry.tenantId === authorization.tenantId &&
            deps.isVisible(entry.meta, authorization.space))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, opts?.limit ?? 20)
          .map((entry) => ({ id: entry.id, content: entry.content }));
      }

      return {
        async recallFunctions(anchors, opts) {
          const rows = await load("tool-function", anchors, opts);
          return rows.map((row) => ({
            id: `state:function:${row.id}`,
            key: row.id,
            source: "tool-function",
            spec: row.content,
          }));
        },
        async recallInsights(anchors, opts) {
          const rows = await load("task-insight", anchors, opts);
          return rows.map((row) => ({ id: `state:insight:${row.id}`, content: row.content }));
        },
      };
    },
  };
}
