/**
 * runner/authorized-task-reads.ts —— N28 T5 唯一 grant-bound 任务读取工厂。
 *
 * AuthorizedTaskReadFactory 是 Memory 读取唯一所有者：retrieve/get/query 全部映射到
 * Broker 的 branded queryVerified（T4 layered 路径）；Skill 经 forScope 端口；state 经
 * AuthorizedStateReadPort。raw 基础 memory/store 方法不得作为 factory 依赖。
 */

import type { MemoryEntry, SkillStoreLike, SkillSummary } from "@away_from/pth-memory";
import { getSkill, listSkills, parseSkillSummary } from "@away_from/pth-memory";
import type { PendingRetrievalTrace, TaskLease, TaskWorkItem, WorkerReplicaRef } from "@away_from/pth-contracts";
import { assertVerifiedTaskReadScope, type KnowledgeBroker, type VerifiedTaskReadScope } from "../execution/index.js";
import type { AuthorizedStateReadPort } from "./authorized-state-reads.js";

export interface AuthorizedTaskReads {
  /** Cheap brand/binding/effective-deadline guard; performs no backing I/O or nonce replay. */
  assertCurrentScope(): void;
  retrieveMemory(opts: {
    anchors?: readonly string[];
    kinds?: readonly string[];
    queryText?: string;
    limit?: number;
  }): Promise<{
    entries: Array<{ id: string } & Record<string, unknown>>;
    trace: PendingRetrievalTrace;
  }>;
  getMemory(id: string): Promise<({ id: string } & Record<string, unknown>) | undefined>;
  queryMemory(sql: string): Promise<Array<{ id: string } & Record<string, unknown>>>;
  recallFunctions(anchors: string[], opts?: { limit?: number }): Promise<Array<{ id: string; key: string; source: string; spec: unknown }>>;
  recallInsights(anchors: string[], opts?: { limit?: number }): Promise<Array<{ id: string; content: string }>>;
  listSkills(): Promise<SkillSummary[]>;
  getSkill(id: string): Promise<MemoryEntry | undefined>;
}

export interface AuthorizedTaskReadFactory {
  forTask(input: {
    lease: TaskLease;
    work: TaskWorkItem;
    space: string;
    worker: WorkerReplicaRef;
    authorization: VerifiedTaskReadScope;
  }): AuthorizedTaskReads;
}

/** 操作→capability 映射（7 个 read surface，逐字冻结；family 名在读取边界不被接受）。 */
export const TASK_READ_CAPABILITIES = Object.freeze({
  "memory.retrieve": "memory.read",
  "memory.get": "memory.read",
  "memory.query": "memory.query",
  "state.recallFunctions": "state.recallFunctions",
  "state.recallInsights": "state.recallInsights",
  "skills.list": "skills.list",
  "skills.get": "skills.get",
} as const);

export function expandTaskReadGrantCapabilities(roleCapabilities: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const capability of roleCapabilities) {
    if (capability === "memory") out.add("memory.read");
    else if (capability === "state") {
      out.add("state.recallFunctions");
      out.add("state.recallInsights");
    } else if (capability === "skills") {
      out.add("skills.list");
      out.add("skills.get");
    } else out.add(capability);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** 生产 skills.forScope 适配器：branded deadline + tenant/official/space 过滤。 */
export function createScopedSkillPort(deps: {
  store: SkillStoreLike;
  isVisible(meta: Record<string, unknown> | undefined, space: string): boolean;
  clock: () => Date;
}): {
  forScope(authorization: VerifiedTaskReadScope): {
    list(): Promise<SkillSummary[]>;
    get(id: string): Promise<MemoryEntry | undefined>;
  };
} {
  return {
    forScope(authorization) {
      assertVerifiedTaskReadScope(authorization, { capabilities: ["skills.list", "skills.get"] }, { clock: deps.clock });
      return {
        async list() {
          assertVerifiedTaskReadScope(authorization, { capabilities: ["skills.list"] }, { clock: deps.clock });
          const summaries = await listSkills(deps.store);
          const out: SkillSummary[] = [];
          for (const summary of summaries) {
            const entry = await getSkill(deps.store, summary.id);
            if (!entry) continue;
            if (entry.status !== "official") continue;
            if (entry.tenantId !== undefined && entry.tenantId !== authorization.tenantId) continue;
            if (!deps.isVisible(entry.meta, authorization.space)) continue;
            out.push(parseSkillSummary(entry));
          }
          return out.sort((a, b) => a.id.localeCompare(b.id));
        },
        async get(id) {
          assertVerifiedTaskReadScope(authorization, { capabilities: ["skills.get"] }, { clock: deps.clock });
          const entry = await getSkill(deps.store, id);
          if (!entry) return undefined;
          if (entry.status !== "official") return undefined;
          if (entry.tenantId !== undefined && entry.tenantId !== authorization.tenantId) return undefined;
          if (!deps.isVisible(entry.meta, authorization.space)) return undefined;
          return entry;
        },
      };
    },
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 8;
  return Math.max(1, Math.min(20, Math.floor(limit)));
}

function normalizeStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function createAuthorizedTaskReadFactory(deps: {
  broker: Pick<KnowledgeBroker, "queryVerified">;
  skills: {
    forScope(authorization: VerifiedTaskReadScope): {
      list(): Promise<SkillSummary[]>;
      get(id: string): Promise<MemoryEntry | undefined>;
    };
  };
  state: AuthorizedStateReadPort;
  clock: () => Date;
}): AuthorizedTaskReadFactory {
  return {
    forTask(input) {
      assertVerifiedTaskReadScope(input.authorization, {
        tenantId: input.work.scope.tenantId,
        principalId: `worker:${input.worker.workerId}`,
        workerId: input.worker.workerId,
        taskId: input.lease.taskId,
        leaseId: input.lease.leaseId,
        generation: input.lease.generation,
        capabilities: ["memory.read"],
      }, { clock: deps.clock });

      const statePort = deps.state.forScope(input.authorization);
      const skillPort = deps.skills.forScope(input.authorization);

      const reads: AuthorizedTaskReads = {
        assertCurrentScope() {
          assertVerifiedTaskReadScope(input.authorization, {
            tenantId: input.work.scope.tenantId,
            workerId: input.worker.workerId,
            capabilities: ["memory.read"],
          }, { clock: deps.clock });
        },
        async retrieveMemory(opts) {
          this.assertCurrentScope();
          const anchors = normalizeStrings(opts.anchors);
          const kinds = normalizeStrings(opts.kinds);
          const explicitQuery = (opts.queryText ?? "").trim();
          const queryText = explicitQuery || anchors.join(" ");
          if (!queryText) throw new Error("memory.retrieve: empty query（anchors 与 queryText 均空）");
          const result = await deps.broker.queryVerified(input.authorization, {
            op: "search",
            queryText,
            domains: anchors,
            ...(kinds.length > 0 ? { kinds } : {}),
            limit: clampLimit(opts.limit),
          });
          if (!result.ok) throw new Error(`memory.retrieve: ${result.error}`);
          const entries = (result.entries ?? []) as Array<{ id: string } & Record<string, unknown>>;
          if (!result.retrievalTrace) throw new Error("memory.retrieve: layered retrieval trace missing");
          return { entries, trace: result.retrievalTrace };
        },
        async getMemory(id) {
          this.assertCurrentScope();
          const result = await deps.broker.queryVerified(input.authorization, { op: "get", id });
          if (!result.ok) return undefined;
          return result.entry as ({ id: string } & Record<string, unknown>) | undefined;
        },
        async queryMemory(sql) {
          this.assertCurrentScope();
          if (!input.authorization.capabilities.includes("memory.query")) {
            throw new Error("memory.query: missing capability memory.query");
          }
          const result = await deps.broker.queryVerified(input.authorization, { op: "query", sql });
          if (!result.ok) throw new Error(`memory.query: ${result.error}`);
          const rows = (result.rows ?? []) as Array<{ id: string } & Record<string, unknown>>;
          for (const row of rows) {
            if (typeof row.id !== "string") throw new Error("memory.query: 每行必须含 id");
          }
          return rows;
        },
        async recallFunctions(anchors, opts) {
          this.assertCurrentScope();
          if (!input.authorization.capabilities.includes("state.recallFunctions")) {
            throw new Error("state.recallFunctions: missing capability");
          }
          return statePort.recallFunctions(anchors, opts);
        },
        async recallInsights(anchors, opts) {
          this.assertCurrentScope();
          if (!input.authorization.capabilities.includes("state.recallInsights")) {
            throw new Error("state.recallInsights: missing capability");
          }
          return statePort.recallInsights(anchors, opts);
        },
        async listSkills() {
          this.assertCurrentScope();
          if (!input.authorization.capabilities.includes("skills.list")) {
            throw new Error("skills.list: missing capability");
          }
          return skillPort.list();
        },
        async getSkill(id) {
          this.assertCurrentScope();
          if (!input.authorization.capabilities.includes("skills.get")) {
            throw new Error("skills.get: missing capability");
          }
          return skillPort.get(id);
        },
      };
      return reads;
    },
  };
}
