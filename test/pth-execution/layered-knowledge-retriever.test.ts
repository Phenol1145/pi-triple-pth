import { describe, expect, it } from "vitest";
import { computeRetrievalQueryFingerprint, createLayeredKnowledgeRetriever } from "../../src/pth/execution/layered-knowledge-retriever.js";
import { createVerifiedTaskReadScopeFactory, type VerifiedTaskReadScope } from "../../src/pth/execution/authorization/verified-task-read-scope.js";
import { createExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import type { TaskLease, TaskWorkItem } from "@away_from/pth-contracts";
import { buildMemoryDirectorySnapshot, regionEntryIds } from "../../src/pth/execution/memory-directory.js";
import { filterKnowledgeEntriesByQueryText, rankKnowledgeEntries } from "../../src/pth/execution/knowledge-ranking.js";
import {
  N28_GOLD_QUERIES,
  N28_DOMAIN_IDS,
  N28_REGIONS,
  N28_RESPONSIBILITIES,
  N28_WORKERS,
  n28AuthorizedCorpus,
  n28DirectoryInputs,
} from "../../scripts/n28-feasibility-fixture.js";

let nowMs = Date.parse("2030-01-01T00:00:00.000Z");
const clock = () => new Date(nowMs);
const grantService = createExecutionGrantService({
  keyProvider: createHmacGrantKeyProvider({ secret: "n28-feasibility-test-secret-0123456789" }),
  clock,
});

describe("layered knowledge retrieval", () => {
  it("recalls all 12 gold targets within the expected wave", async () => {
    for (const query of N28_GOLD_QUERIES) {
      const result = await harness(N28_WORKERS[query.workerKey].workerId).search(query.text, 8);
      expect(result.status).toBe("found");
      expect(result.entries.some((entry) => entry.id === query.expected), query.id).toBe(true);
      const wave = result.trace.waves.find((item) => item.selectedEntryIds.includes(query.expected));
      expect(wave?.wave, query.id).toBe(query.expectedWave);
      expect(result.trace.waves.map((item) => item.wave)).toEqual([0, 1, 2, 3]);
    }
  });

  it("wave trace counts are honest：candidate >= visible >= selected 且 scanned/selectedEntryIds 自洽（B7）", async () => {
    for (const query of N28_GOLD_QUERIES) {
      const result = await harness(N28_WORKERS[query.workerKey].workerId).search(query.text, 8);
      for (const wave of result.trace.waves) {
        expect(wave.candidateCount, query.id).toBeGreaterThanOrEqual(wave.visibleCount);
        expect(wave.visibleCount, query.id).toBeGreaterThanOrEqual(wave.selectedCount);
        expect(wave.scannedCount, query.id).toBeGreaterThanOrEqual(wave.selectedCount);
        expect(wave.selectedEntryIds, query.id).toHaveLength(wave.selectedCount);
      }
    }
  });

  it("distinguishes a complete no-answer from incomplete and failed retrieval", async () => {
    expect((await harness(N28_WORKERS.algebra.workerId).search("no-such-token", 8)).status).toBe("exhausted-empty");
    expect((await harness(N28_WORKERS.algebra.workerId, { completeForQuery: false }).search("no-such-token", 8)).status).toBe("retrieval-incomplete");
    expect((await harness(N28_WORKERS.algebra.workerId, { failWave: 2 }).search("no-such-token", 8)).status).toBe("retrieval-failed");
  });
});

const scopeFactory = createVerifiedTaskReadScopeFactory({
  grantService,
  grantForTask: ({ lease, work, space, worker }) => grantService.issue({
    lease,
    scope: { ...work.scope, principalId: `worker:${worker.workerId}`, roles: [worker.role.roleId], space },
    workspace: lease.workspace,
    language: "ts",
    capabilities: [
      "memory.read",
      "memory.query",
      "state.recallFunctions",
      "state.recallInsights",
      "skills.list",
      "skills.get",
    ],
  }),
});

function verifiedScopeFor(workerId: string): VerifiedTaskReadScope {
  const worker = Object.values(N28_WORKERS).find((item) => item.workerId === workerId)!;
  const scope = { tenantId: "tenant-a", principalId: `worker:${workerId}`, roles: [worker.role.roleId], traceId: "trace-n28", space: "meta" };
  const lease: TaskLease = {
    taskId: "task-n28", leaseId: "20000000-0000-4000-8000-000000000001", generation: 1,
    scope, workspace: { tenantId: "tenant-a", workspaceId: "ws-n28", taskId: "task-n28" },
    roleId: worker.role.roleId, deadlineAt: "2030-01-01T00:01:00.000Z",
  };
  const work: TaskWorkItem = { taskId: lease.taskId, scope, title: "n28", text: "n28", tags: [], payload: {}, assignedRole: worker.role.roleId, domains: ["mathematics"] };
  return scopeFactory.forTask({ lease, work, space: "meta", worker });
}

function harness(workerId: string, mode: { completeForQuery?: boolean; failWave?: number } = {}) {
  const corpus = n28AuthorizedCorpus();
  const directoryEntries = n28DirectoryInputs(corpus);
  const directory = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: directoryEntries });
  const retriever = createLayeredKnowledgeRetriever(directory, { knownDomainIds: N28_DOMAIN_IDS, entries: directoryEntries }, { clock });
  return {
    search: (queryText: string, limit: number) => {
      const authorization = verifiedScopeFor(workerId);
      return retriever.search({
        authorization,
        workerId,
        queryText,
        queryFingerprint: computeRetrievalQueryFingerprint({ authorization, queryText, domains: ["mathematics"], directorySnapshotId: directory.snapshotId }),
        domains: ["mathematics"],
        limit,
        searchWave: async ({ authorization: waveAuthorization, wave, candidateScope, regionIds, limit: waveLimit }) => {
          if (waveAuthorization !== authorization) throw new Error("authorization identity changed");
          if (mode.failWave === wave) throw new Error("injected wave failure");
          const regionSet = new Set(regionIds.flatMap((regionId) => regionEntryIds(directory, regionId)));
          const inWave = corpus.filter((entry) => candidateScope === "global" || regionSet.has(entry.id));
          const matching = filterKnowledgeEntriesByQueryText(inWave, queryText, { strict: true });
          const ranked = rankKnowledgeEntries(matching, { queryText, domains: ["mathematics"] });
          return {
            entries: ranked.slice(0, waveLimit),
            candidateCount: inWave.length,
            visibleCount: inWave.length,
            scannedCount: inWave.length,
            completeForQuery: mode.completeForQuery ?? true,
          };
        },
      });
    },
  };
}
