/**
 * execution/layered-knowledge-retriever.ts —— N28 T4 分层扩检检索器。
 *
 * 一次任务冻结 Directory Snapshot，为当前 WorkerReplica 生成固定四波检索：
 *   Wave 0 primary → Wave 1 overlap → Wave 2 fallback + unclassified → Wave 3 bounded global
 * 每波先廉价校验同一 branded VerifiedTaskReadScope（不重放 HMAC/replay），
 * wave port 必须先 Region + strict query + rank 再 limit，并诚实声明 completeForQuery。
 * 四波后统一 merge/dedupe/rank；返回 found/exhausted-empty/retrieval-incomplete/retrieval-failed。
 */

import { createHash } from "node:crypto";
import type { PendingRetrievalTrace, RetrievalWaveTrace, WorkerReplicaRef } from "@away_from/pth-contracts";
import { knowledgeQueryTokenHits, rankKnowledgeEntries, type RankableKnowledgeEntry } from "./knowledge-ranking.js";
import { assertMemoryDirectorySnapshotIntegrity, responsibilitiesForWorker, type DirectoryEntryInput, type MemoryDirectorySnapshot } from "./memory-directory.js";
import { assertVerifiedTaskReadScope, type VerifiedTaskReadScope } from "./authorization/verified-task-read-scope.js";

export interface LayeredSearchWaveInput {
  /** Exact branded scope created once for this task; adapters may not reconstruct it. */
  authorization: VerifiedTaskReadScope;
  wave: 0 | 1 | 2 | 3;
  /** Empty regions never mean global; global scope is explicit. */
  candidateScope: "regions" | "global";
  regionIds: readonly string[];
  queryText: string;
  limit: number;
}

export interface LayeredSearchWaveResult<T> {
  entries: readonly T[];
  /** Rows in the bounded Region/global candidate scope before tenant/space/status filtering. */
  candidateCount: number;
  /** Rows remaining after server-side authorization predicates and before query/rank limit. */
  visibleCount: number;
  scannedCount: number;
  /** True only when this adapter applied query + Region predicates before limit. */
  completeForQuery: boolean;
}

export interface LayeredRetrievalRequest<T extends RankableKnowledgeEntry> {
  authorization: VerifiedTaskReadScope;
  workerId: string;
  queryText: string;
  /** Produced by the shared retrieval-query fingerprint helper used by Broker and Context. */
  queryFingerprint: string;
  domains: readonly string[];
  limit: number;
  searchWave(input: LayeredSearchWaveInput): Promise<LayeredSearchWaveResult<T>>;
}

export type RetrievalStatus = "found" | "exhausted-empty" | "retrieval-incomplete" | "retrieval-failed";

export interface LayeredRetrievalResult<T> {
  status: RetrievalStatus;
  entries: T[];
  error?: string;
  trace: PendingRetrievalTrace & { waves: Array<RetrievalWaveTrace & { selectedEntryIds: string[] }> };
}

export interface LayeredKnowledgeRetriever<T extends RankableKnowledgeEntry> {
  readonly directory: MemoryDirectorySnapshot;
  entryIdsForRegions(regionIds: readonly string[]): ReadonlySet<string>;
  search(request: LayeredRetrievalRequest<T>): Promise<LayeredRetrievalResult<T>>;
}

export function computeRetrievalQueryFingerprint(input: {
  authorization: VerifiedTaskReadScope;
  queryText: string;
  domains: readonly string[];
  directorySnapshotId: string;
}): string {
  const { authorization } = input;
  const domains = [...input.domains].sort((a, b) => a.localeCompare(b));
  const digestInput = JSON.stringify({
    tenantId: authorization.tenantId,
    space: authorization.space,
    taskId: authorization.lease.taskId,
    leaseId: authorization.lease.leaseId,
    generation: authorization.lease.generation,
    workerId: authorization.worker.workerId,
    queryText: (input.queryText ?? "").trim(),
    domains,
    directorySnapshotId: input.directorySnapshotId,
  });
  return `q-${createHash("sha256").update(digestInput).digest("hex").slice(0, 16)}`;
}

const KIND_ORDER: Record<string, number> = { primary: 0, overlap: 1, fallback: 2 };

interface PlannedWave {
  wave: 0 | 1 | 2 | 3;
  candidateScope: "regions" | "global";
  regionIds: string[];
}

function planWaves(directory: MemoryDirectorySnapshot, workerId: string): PlannedWave[] {
  const responsibilities = responsibilitiesForWorker(directory, workerId);
  const byKind = (kind: string) => responsibilities
    .filter((item) => item.kind === kind)
    .sort((a, b) => (a.priority - b.priority) || a.regionId.localeCompare(b.regionId))
    .map((item) => item.regionId);
  const primary = byKind("primary");
  const overlap = byKind("overlap");
  const fallback = [...new Set([...byKind("fallback"), "region:unclassified"])].sort();
  void KIND_ORDER;
  return [
    { wave: 0, candidateScope: "regions", regionIds: primary },
    { wave: 1, candidateScope: "regions", regionIds: overlap },
    { wave: 2, candidateScope: "regions", regionIds: fallback },
    { wave: 3, candidateScope: "global", regionIds: [] },
  ];
}

function emptyTrace(request: LayeredRetrievalRequest<RankableKnowledgeEntry>, status: RetrievalStatus, error?: string): LayeredRetrievalResult<never>["trace"] {
  const waves = ([0, 1, 2, 3] as const).map((wave) => ({
    wave,
    regionIds: [] as string[],
    candidateCount: 0,
    visibleCount: 0,
    selectedCount: 0,
    scannedCount: 0,
    completeForQuery: true,
    reason: error ? "retrieval-failed" : status,
    selectedEntryIds: [] as string[],
  }));
  return {
    directorySnapshotId: "",
    workerId: request.workerId,
    queryFingerprint: request.queryFingerprint,
    waves,
    globalFallback: false,
    omitted: {},
    status,
  };
}

export function createLayeredKnowledgeRetriever<T extends RankableKnowledgeEntry>(
  directory: MemoryDirectorySnapshot,
  integritySource: { knownDomainIds: ReadonlySet<string>; entries: readonly DirectoryEntryInput[] },
  opts: { clock: () => Date },
): LayeredKnowledgeRetriever<T> {
  assertMemoryDirectorySnapshotIntegrity(directory, integritySource);

  return {
    directory,
    entryIdsForRegions(regionIds) {
      const ids = new Set<string>();
      for (const membership of directory.memberships) {
        if (membership.regionIds.some((regionId) => regionIds.includes(regionId))) ids.add(membership.entryId);
      }
      return ids;
    },
    async search(request): Promise<LayeredRetrievalResult<T>> {
      assertVerifiedTaskReadScope(request.authorization, {
        tenantId: directory.tenantId,
        workerId: request.workerId,
      }, { clock: opts.clock });
      if (request.workerId !== request.authorization.worker.workerId) {
        return { status: "retrieval-failed", entries: [], error: "worker binding mismatch", trace: emptyTrace(request, "retrieval-failed", "worker binding mismatch") };
      }
      if (directory.tenantId !== request.authorization.tenantId) {
        return { status: "retrieval-failed", entries: [], error: "directory tenant mismatch", trace: emptyTrace(request, "retrieval-failed", "directory tenant mismatch") };
      }

      const perWaveLimit = Math.min(20, Math.max(request.limit * 2, 8));
      const waves = planWaves(directory, request.workerId);
      const merged = new Map<string, { entry: T; firstWave: number }>();
      const traces: Array<RetrievalWaveTrace & { selectedEntryIds: string[] }> = [];
      const omitted: Record<string, number> = {};
      let anyIncomplete = false;

      for (const planned of waves) {
        assertVerifiedTaskReadScope(request.authorization, {
          tenantId: directory.tenantId,
          workerId: request.workerId,
        }, { clock: opts.clock });
        try {
          const result = await request.searchWave({
            authorization: request.authorization,
            wave: planned.wave,
            candidateScope: planned.candidateScope,
            regionIds: planned.regionIds,
            queryText: request.queryText,
            limit: perWaveLimit,
          });
          const selectedEntryIds: string[] = [];
          for (const entry of result.entries) {
            const id = (entry as { id: string }).id;
            selectedEntryIds.push(id);
            if (!merged.has(id)) merged.set(id, { entry, firstWave: planned.wave });
          }
          if (!result.completeForQuery) anyIncomplete = true;
          omitted[`wave:${planned.wave}`] = Math.max(0, result.visibleCount - result.entries.length);
          traces.push({
            wave: planned.wave,
            regionIds: [...planned.regionIds],
            candidateCount: result.candidateCount,
            visibleCount: result.visibleCount,
            selectedCount: result.entries.length,
            scannedCount: result.scannedCount,
            completeForQuery: result.completeForQuery,
            reason: planned.candidateScope === "global" ? "global" : planned.regionIds.join("|"),
            selectedEntryIds,
          });
        } catch (error) {
          return {
            status: "retrieval-failed",
            entries: [],
            error: error instanceof Error ? error.message : String(error),
            trace: {
              directorySnapshotId: directory.snapshotId,
              workerId: request.workerId,
              queryFingerprint: request.queryFingerprint,
              waves: traces,
              globalFallback: false,
              omitted,
              status: "retrieval-failed",
            },
          };
        }
      }

      const ranked = rankKnowledgeEntries([...merged.values()].map((item) => item.entry), {
        queryText: request.queryText,
        domains: request.domains,
      });
      const entries = ranked.slice(0, request.limit);
      const hasHit = entries.some((entry) => knowledgeQueryTokenHits(entry, request.queryText) > 0);
      const allComplete = traces.every((trace) => trace.completeForQuery);
      const globalFallback = (traces.find((trace) => trace.wave === 3)?.selectedEntryIds.length ?? 0) > 0;
      let status: RetrievalStatus;
      if (hasHit) status = "found";
      else if (allComplete) status = "exhausted-empty";
      else if (anyIncomplete) status = "retrieval-incomplete";
      else status = "exhausted-empty";

      return {
        status,
        entries,
        trace: {
          directorySnapshotId: directory.snapshotId,
          workerId: request.workerId,
          queryFingerprint: request.queryFingerprint,
          waves: traces,
          globalFallback,
          omitted,
          status,
        },
      };
    },
  };
}
