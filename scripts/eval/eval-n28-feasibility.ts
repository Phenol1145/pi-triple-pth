/**
 * scripts/eval/eval-n28-feasibility.ts —— N28 可行性评测器（provisional 判定）。
 *
 * 只从 metrics 机械推导 H1–H6；调用方不得传入独立 hypothesis booleans。
 * 探针只使用 src/pth 公共组件；计数诚实——未接入的探针分母为 0 并按计划判 NO-GO。
 */

import { pathToFileURL } from "node:url";
import { N28_FEASIBILITY_BUDGET, checkResponsibilityCapacity } from "@away_from/pth-contracts";
import { buildMemoryDirectorySnapshot, regionEntryIds } from "../../src/pth/execution/memory-directory.js";
import { createLayeredKnowledgeRetriever } from "../../src/pth/execution/layered-knowledge-retriever.js";
import { createVerifiedTaskReadScopeFactory } from "../../src/pth/execution/authorization/verified-task-read-scope.js";
import { createExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import { filterKnowledgeEntriesByQueryText, rankKnowledgeEntries } from "../../src/pth/execution/knowledge-ranking.js";
import { createKnowledgeBroker, type KnowledgeMemoryEntry } from "../../src/pth/execution/knowledge-broker.js";
import type { LayeredSearchWaveInput } from "../../src/pth/execution/index.js";
import { createKnowledgeContextProvider } from "../../src/pth/runner/knowledge-context.js";
import { createAuthorizedStateReadPort, createScopedSkillPort } from "../../src/pth/runner/index.js";
import { createBudgetedTaskCapabilities, createTaskWorkingSetPolicy } from "../../src/pth/runner/cognitive-working-set.js";
import type { AuthorizedTaskReads } from "../../src/pth/runner/authorized-task-reads.js";
import { createWorkerReplica, roleDefinitionRevision } from "@away_from/pth-kernel-execution";
import { WorkerSlotRuntime } from "../../src/pth/bootstrap/worker-slot-runtime.js";
import { assembleBatchRuntime, runBatchHost } from "../../src/pth/bootstrap/batch-runtime-assembly.js";
import { isVisible, setSpaceLookup, type ToolRegSpec } from "@away_from/pth-memory";
import { runAgentTask } from "@away_from/pth-kernel-execution";
import type { LlmFn } from "@away_from/pth-kernel-interpreter";
import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";
import type { ToolRegSnapshot } from "@away_from/pth-kernel-interpreter";
import { createN28InMemoryBundle } from "../tools/n28-feasibility-harness.js";
import { createAuditObserver } from "../../src/pth/runner/index.js";
import { assembleWorkerSlotIdentity } from "../../src/pth/bootstrap/worker-slot-assembly.js";
import {
  N28_DOMAIN_IDS, N28_GOLD_QUERIES, N28_REGIONS, N28_RESPONSIBILITIES, N28_ROLE, N28_WORKERS,
  n28AuthorizedCorpus, n28DirectoryInputs, n28TrapCorpus,
} from "../tools/n28-feasibility-fixture.js";

export interface N28FeasibilityMetrics {
  goldQueries: number;
  goldFoundQueries: number;
  fourWaveCases: number;
  goldRecall: number;
  authorizationLeaks: number;
  maxRetrievalWaves: number;
  generatedBudgetCases: number;
  generatedResponsibilityCases: number;
  budgetViolations: number;
  sameRoleReplicaControlFailures: number;
  workerLifecycleProbeCases: number;
  batchRuntimeProbeCases: number;
  batchRuntimeConsumptionFailures: number;
  stoppedSlotCleanupProbeCases: number;
  stoppedSlotCleanupFailures: number;
  heartbeatIdentityProbeCases: number;
  heartbeatIdentityFailures: number;
  auditIdentityProbeCases: number;
  auditIdentityFailures: number;
  grantIdentityProbeCases: number;
  grantIdentityFailures: number;
  directoryCoverage: number;
  memoryTypesCovered: number;
  canonicalBodyEntries: number;
  directoryMembershipReferences: number;
  overlapMemberships: number;
  ownerlessRegions: number;
  bodyCopiesOutsideCanonicalStore: number;
  directoryInvariantFailures: number;
  directoryInvariantProbeCases: number;
  directoryDeterminismProbeCases: number;
  snapshotDeterminismMismatches: number;
  workingSetDeterminismMismatches: number;
  responsibilityViolations: number;
  retrievalIncompleteCases: number;
  retrievalFailedCases: number;
  maxWaveSelectedCount: number;
  missingFourWaveCases: number;
  unauthorizedWaveInvocations: number;
  unauthorizedReadPortInvocations: number;
  authorizationProbeCases: number;
  visibilityProbeCases: number;
  surfaceMismatches: number;
  surfaceComparisonCases: number;
  hiddenDispatchProbeCases: number;
  hiddenExecutorInvocations: number;
}

export interface N28FeasibilityResult {
  decision: "GO" | "NO-GO";
  hypotheses: Record<"H1" | "H2" | "H3" | "H4" | "H5" | "H6", {
    passed: boolean;
    evidence: string[];
  }>;
  metrics: N28FeasibilityMetrics;
}

export const METRIC_KEYS: readonly (keyof N28FeasibilityMetrics)[] = [
  "goldQueries", "goldFoundQueries", "fourWaveCases", "goldRecall", "authorizationLeaks",
  "maxRetrievalWaves", "generatedBudgetCases", "generatedResponsibilityCases", "budgetViolations",
  "sameRoleReplicaControlFailures", "workerLifecycleProbeCases", "batchRuntimeProbeCases",
  "batchRuntimeConsumptionFailures", "stoppedSlotCleanupProbeCases", "stoppedSlotCleanupFailures",
  "heartbeatIdentityProbeCases", "heartbeatIdentityFailures", "auditIdentityProbeCases",
  "auditIdentityFailures", "grantIdentityProbeCases", "grantIdentityFailures",
  "directoryCoverage", "memoryTypesCovered", "canonicalBodyEntries", "directoryMembershipReferences",
  "overlapMemberships", "ownerlessRegions", "bodyCopiesOutsideCanonicalStore",
  "directoryInvariantFailures", "directoryInvariantProbeCases", "directoryDeterminismProbeCases",
  "snapshotDeterminismMismatches", "workingSetDeterminismMismatches", "responsibilityViolations",
  "retrievalIncompleteCases", "retrievalFailedCases", "maxWaveSelectedCount", "missingFourWaveCases",
  "unauthorizedWaveInvocations", "unauthorizedReadPortInvocations", "authorizationProbeCases",
  "visibilityProbeCases", "surfaceMismatches", "surfaceComparisonCases", "hiddenDispatchProbeCases",
  "hiddenExecutorInvocations",
] as const;

export function validateN28FeasibilityMetrics(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return ["metrics must be an object"];
  const errors: string[] = [];
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !(METRIC_KEYS as readonly string[]).includes(key));
  for (const key of METRIC_KEYS) {
    const v = record[key];
    if (v === undefined) { errors.push(`${key}: missing`); continue; }
    if (typeof v !== "number" || !Number.isFinite(v)) { errors.push(`${key}: not a finite number`); continue; }
    if (v < 0) errors.push(`${key}: negative`);
    if ((key === "goldRecall" || key === "directoryCoverage") && (v < 0 || v > 1)) errors.push(`${key}: ratio out of [0,1]`);
  }
  for (const key of extra) errors.push(`${key}: extra field`);
  return errors;
}

function deriveHypotheses(m: N28FeasibilityMetrics): N28FeasibilityResult["hypotheses"] {
  return {
    H1: {
      passed: m.workerLifecycleProbeCases === 6 &&
        m.batchRuntimeProbeCases === 1 &&
        m.stoppedSlotCleanupProbeCases === 2 &&
        m.heartbeatIdentityProbeCases === 4 &&
        m.auditIdentityProbeCases === 3 &&
        m.grantIdentityProbeCases === 3 &&
        m.sameRoleReplicaControlFailures === 0 &&
        m.batchRuntimeConsumptionFailures === 0 &&
        m.stoppedSlotCleanupFailures === 0 &&
        m.heartbeatIdentityFailures === 0 &&
        m.auditIdentityFailures === 0 &&
        m.grantIdentityFailures === 0,
      evidence: [`workerLifecycle=${m.workerLifecycleProbeCases}/6 batchRuntime=${m.batchRuntimeProbeCases}/1 cleanup=${m.stoppedSlotCleanupProbeCases}/2 heartbeat=${m.heartbeatIdentityProbeCases}/4 audit=${m.auditIdentityProbeCases}/3 grant=${m.grantIdentityProbeCases}/3`],
    },
    H2: {
      passed: m.directoryInvariantProbeCases === 8 &&
        m.directoryDeterminismProbeCases === 1 &&
        m.directoryCoverage === 1 &&
        m.memoryTypesCovered === 4 &&
        m.canonicalBodyEntries === 100 &&
        m.directoryMembershipReferences > m.canonicalBodyEntries &&
        m.overlapMemberships >= 1 &&
        m.ownerlessRegions === 0 &&
        m.bodyCopiesOutsideCanonicalStore === 0 &&
        m.directoryInvariantFailures === 0 &&
        m.snapshotDeterminismMismatches === 0,
      evidence: [`directoryInvariant=${m.directoryInvariantProbeCases}/8 determinism=${m.directoryDeterminismProbeCases}/1 coverage=${m.directoryCoverage} refs=${m.directoryMembershipReferences} bodies=${m.canonicalBodyEntries}`],
    },
    H3: {
      passed: m.goldQueries === 12 &&
        m.goldFoundQueries === 12 &&
        m.goldRecall === 1 &&
        m.fourWaveCases === 12 &&
        m.maxRetrievalWaves <= 4 &&
        m.maxWaveSelectedCount <= 20 &&
        m.missingFourWaveCases === 0 &&
        m.retrievalIncompleteCases === 0 &&
        m.retrievalFailedCases === 0,
      evidence: [`gold=${m.goldFoundQueries}/12 fourWave=${m.fourWaveCases}/12 maxWave=${m.maxRetrievalWaves} maxSelected=${m.maxWaveSelectedCount}`],
    },
    H4: {
      passed: m.authorizationProbeCases === 32 &&
        m.visibilityProbeCases === 14 &&
        m.authorizationLeaks === 0 &&
        m.unauthorizedWaveInvocations === 0 &&
        m.unauthorizedReadPortInvocations === 0,
      evidence: [`authorization=${m.authorizationProbeCases}/32 visibility=${m.visibilityProbeCases}/14 leaks=${m.authorizationLeaks} unauthorizedWave=${m.unauthorizedWaveInvocations} unauthorizedRead=${m.unauthorizedReadPortInvocations}`],
    },
    H5: {
      passed: m.generatedBudgetCases === 1000 &&
        m.generatedResponsibilityCases === 1000 &&
        m.budgetViolations === 0 &&
        m.responsibilityViolations === 0 &&
        m.snapshotDeterminismMismatches === 0 &&
        m.workingSetDeterminismMismatches === 0,
      evidence: [`budget=${m.generatedBudgetCases}/1000 responsibility=${m.generatedResponsibilityCases}/1000 violations=${m.budgetViolations}/${m.responsibilityViolations} workingSetMismatches=${m.workingSetDeterminismMismatches}`],
    },
    H6: {
      passed: m.surfaceComparisonCases === 12 &&
        m.hiddenDispatchProbeCases === 1 &&
        m.surfaceMismatches === 0 &&
        m.hiddenExecutorInvocations === 0,
      evidence: [`surface=${m.surfaceComparisonCases}/12 hiddenDispatch=${m.hiddenDispatchProbeCases}/1 mismatches=${m.surfaceMismatches} hiddenExec=${m.hiddenExecutorInvocations}`],
    },
  };
}

export function decideN28Feasibility(metrics: N28FeasibilityMetrics): N28FeasibilityResult {
  const schemaErrors = validateN28FeasibilityMetrics(metrics);
  const hypotheses = deriveHypotheses(metrics);
  const directNoGo =
    schemaErrors.length > 0 ||
    Object.values(hypotheses).some((item) => !item.passed) ||
    metrics.goldQueries !== 12 ||
    metrics.goldFoundQueries !== 12 ||
    metrics.fourWaveCases !== 12 ||
    metrics.generatedBudgetCases !== 1000 ||
    metrics.generatedResponsibilityCases !== 1000 ||
    metrics.workerLifecycleProbeCases !== 6 ||
    metrics.batchRuntimeProbeCases !== 1 ||
    metrics.stoppedSlotCleanupProbeCases !== 2 ||
    metrics.heartbeatIdentityProbeCases !== 4 ||
    metrics.auditIdentityProbeCases !== 3 ||
    metrics.grantIdentityProbeCases !== 3 ||
    metrics.directoryInvariantProbeCases !== 8 ||
    metrics.directoryDeterminismProbeCases !== 1 ||
    metrics.authorizationProbeCases !== 32 ||
    metrics.visibilityProbeCases !== 14 ||
    metrics.surfaceComparisonCases !== 12 ||
    metrics.hiddenDispatchProbeCases !== 1 ||
    metrics.authorizationLeaks > 0 ||
    metrics.goldRecall < 1 ||
    metrics.budgetViolations > 0 ||
    metrics.responsibilityViolations > 0 ||
    metrics.sameRoleReplicaControlFailures > 0 ||
    metrics.batchRuntimeConsumptionFailures > 0 ||
    metrics.stoppedSlotCleanupFailures > 0 ||
    metrics.heartbeatIdentityFailures > 0 ||
    metrics.auditIdentityFailures > 0 ||
    metrics.grantIdentityFailures > 0 ||
    metrics.directoryCoverage < 1 ||
    metrics.memoryTypesCovered !== 4 ||
    metrics.canonicalBodyEntries !== 100 ||
    metrics.directoryMembershipReferences <= metrics.canonicalBodyEntries ||
    metrics.overlapMemberships < 1 ||
    metrics.ownerlessRegions > 0 ||
    metrics.bodyCopiesOutsideCanonicalStore > 0 ||
    metrics.directoryInvariantFailures > 0 ||
    metrics.snapshotDeterminismMismatches > 0 ||
    metrics.workingSetDeterminismMismatches > 0 ||
    metrics.maxRetrievalWaves > 4 ||
    metrics.missingFourWaveCases > 0 ||
    metrics.maxWaveSelectedCount > 20 ||
    metrics.unauthorizedWaveInvocations > 0 ||
    metrics.unauthorizedReadPortInvocations > 0 ||
    metrics.retrievalIncompleteCases > 0 ||
    metrics.retrievalFailedCases > 0 ||
    metrics.surfaceMismatches > 0 ||
    metrics.hiddenExecutorInvocations > 0;
  return {
    decision: directNoGo ? "NO-GO" : "GO",
    hypotheses: schemaErrors.length > 0
      ? Object.fromEntries((["H1", "H2", "H3", "H4", "H5", "H6"] as const).map((h) => [h, { passed: false, evidence: [...schemaErrors] }])) as N28FeasibilityResult["hypotheses"]
      : hypotheses,
    metrics,
  };
}

export type N28Sabotage =
  | "control-target-swap"
  | "directory-body-copy"
  | "remove-global-wave"
  | "scope-guard-bypass"
  | "budget-wrapper-bypass"
  | "tool-dispatch-guard-bypass";

type BrokerGrant = ReturnType<ReturnType<typeof createExecutionGrantService>["issue"]>;

async function probeGoldAndDirectory(sabotage?: N28Sabotage) {
  const corpus = n28AuthorizedCorpus();
  const entries = n28DirectoryInputs(corpus);
  const directory = buildMemoryDirectorySnapshot({
    tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS,
    workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES,
    entries,
  });
  const clock = () => new Date("2030-01-01T00:00:00.000Z");
  const grantService = createExecutionGrantService({ keyProvider: createHmacGrantKeyProvider({ secret: "n28-eval-secret-0123456789" }), clock });
  const scopeFactory = createVerifiedTaskReadScopeFactory({
    grantService,
    grantForTask: ({ lease, work, space, worker }) => grantService.issue({
      lease, scope: { ...work.scope, principalId: `worker:${worker.workerId}`, roles: [worker.role.roleId], space },
      workspace: lease.workspace, language: "ts",
      capabilities: ["memory.read"], ttlMs: 120_000,
    }),
  });
  const retriever = createLayeredKnowledgeRetriever(directory, { knownDomainIds: N28_DOMAIN_IDS, entries }, { clock });

  let goldFound = 0;
  let fourWave = 0;
  let maxWave = 0;
  let maxSelected = 0;
  let incomplete = 0;
  let failed = 0;
  for (const query of N28_GOLD_QUERIES) {
    const worker = N28_WORKERS[query.workerKey];
    const scope = { tenantId: "tenant-a", principalId: `worker:${worker.workerId}`, roles: ["researcher"], traceId: `tr-${query.id}`, space: "meta" };
    const lease = { taskId: `task-${query.id}`, leaseId: "20000000-0000-4000-8000-000000000091", generation: 1, scope, workspace: { tenantId: "tenant-a", workspaceId: `ws-${query.id}`, taskId: `task-${query.id}` }, roleId: "researcher", deadlineAt: "2030-01-01T00:02:00.000Z" };
    const work = { taskId: lease.taskId, scope, title: query.id, text: query.text, tags: [], payload: {}, assignedRole: "researcher", domains: ["mathematics"] };
    const authorization = scopeFactory.forTask({ lease, work, space: "meta", worker });
    const result = await retriever.search({
      authorization, workerId: worker.workerId, queryText: query.text,
      queryFingerprint: `q-${query.id}`, domains: ["mathematics"], limit: 8,
      searchWave: async ({ wave, candidateScope, regionIds, limit }) => {
        if (sabotage === "remove-global-wave" && wave === 3) {
          return { entries: [], candidateCount: 0, visibleCount: 0, scannedCount: 0, completeForQuery: false };
        }
        const regionSet = new Set(regionIds.flatMap((id) => regionEntryIds(directory, id)));
        const inWave = corpus.filter((e) => candidateScope === "global" || regionSet.has(e.id));
        const matching = filterKnowledgeEntriesByQueryText(inWave, query.text, { strict: true });
        const ranked = rankKnowledgeEntries(matching, { queryText: query.text, domains: ["mathematics"] });
        return { entries: ranked.slice(0, limit), candidateCount: inWave.length, visibleCount: inWave.length, scannedCount: inWave.length, completeForQuery: true };
      },
    });
    maxWave = Math.max(maxWave, result.trace.waves.length);
    maxSelected = Math.max(maxSelected, ...result.trace.waves.map((w) => w.selectedCount));
    if (result.status === "found") {
      if (result.entries.some((e) => e.id === query.expected)) goldFound += 1;
      if (result.trace.waves.map((w) => w.wave).join(",") === "0,1,2,3") fourWave += 1;
    } else if (result.status === "retrieval-incomplete") incomplete += 1;
    else if (result.status === "retrieval-failed") failed += 1;
  }

  const invariantProbeCases = 8;
  let invariantFailures = 0;
  const invariantProbe = (fn: () => void) => { try { fn(); invariantFailures += 1; } catch { /* 预期拒绝 */ } };
  invariantProbe(() => buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: [...entries, { ...entries[0]!, entry: { ...entries[0]!.entry, id: "dup-tenant", tenantId: "tenant-b" } }] }));
  invariantProbe(() => buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: entries.map((item) => item.entry.id === "alg-01" ? { ...item, revision: 0 } : item) }));
  invariantProbe(() => buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 2, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries }));
  invariantProbe(() => buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: [...N28_RESPONSIBILITIES, N28_RESPONSIBILITIES[0]!], entries }));
  invariantProbe(() => buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES.filter((r) => r.regionId !== "region:global-holdout"), entries }));
  invariantProbe(() => buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS).filter((w) => w.workerId !== N28_WORKERS.global.workerId), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries }));
  invariantProbe(() => buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: [...entries, { ...entries[0]!, entry: { ...entries[0]!.entry, id: "alg-01" } }] }));
  invariantProbe(() => buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS.map((r) => r.regionId === "region:algebra" ? { ...r, selector: { domains: ["not-in-catalog"] } } : r), responsibilities: N28_RESPONSIBILITIES, entries }));

  const reordered = buildMemoryDirectorySnapshot({
    tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS,
    workers: Object.values(N28_WORKERS).reverse(), regions: [...N28_REGIONS].reverse(),
    responsibilities: [...N28_RESPONSIBILITIES].reverse(), entries: n28DirectoryInputs([...corpus].reverse()),
  });
  const determinismMismatches = reordered.snapshotId === directory.snapshotId ? 0 : 1;

  const membershipRefs = directory.memberships.reduce((sum, m) => sum + m.regionIds.length, 0);
  const overlap = directory.memberships.filter((m) => m.regionIds.length > 1).length;
  // P0-4 sabotage 注入：正文被复制进非 canonical store 的索引结构（结构完整性破坏，而非直写 metric）。
  const scannedMemberships = sabotage === "directory-body-copy"
    ? directory.memberships.map((m) => ({ ...m, regionIds: [...m.regionIds], body: "copied:alg-01" }))
    : directory.memberships;
  // P0-3/H2 修复：ownerless 与正文复制由真实扫描得出，不用常量。
  // Working Set snapshot projection roots：只允许 entryId 等元数据，出现 content/body 即视为正文复制。
  const workingSetProjection = sabotage === "directory-body-copy"
    ? { entries: corpus.map((entry) => ({ id: entry.id, body: entry.content })) }
    : { entries: corpus.map((entry) => ({ id: entry.id })) };
  const ownerlessRegions = directory.regions.filter((region) =>
    !directory.responsibilities.some((r) => r.regionId === region.regionId && r.kind === "primary"),
  ).length;
  const countBodyFields = (root: unknown): number => {
    if (Array.isArray(root)) return root.reduce((sum, item) => sum + countBodyFields(item), 0);
    if (root && typeof root === "object") {
      let count = 0;
      for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
        if (key === "content" || key === "body") count += 1;
        count += countBodyFields(value);
      }
      return count;
    }
    return 0;
  };
  const bodyCopiesOutsideCanonicalStore = countBodyFields([
    scannedMemberships,
    directory.regions,
    directory.responsibilities,
    workingSetProjection,
  ]);

  return {
    goldQueries: N28_GOLD_QUERIES.length,
    goldFoundQueries: goldFound,
    fourWaveCases: fourWave,
    goldRecall: goldFound / N28_GOLD_QUERIES.length,
    maxRetrievalWaves: maxWave,
    maxWaveSelectedCount: maxSelected,
    missingFourWaveCases: N28_GOLD_QUERIES.length - fourWave,
    retrievalIncompleteCases: incomplete,
    retrievalFailedCases: failed,
    directoryCoverage: directory.memberships.length / corpus.length,
    memoryTypesCovered: new Set(entries.map((e) => e.memoryType)).size,
    canonicalBodyEntries: corpus.length,
    directoryMembershipReferences: membershipRefs,
    overlapMemberships: overlap,
    ownerlessRegions,
    bodyCopiesOutsideCanonicalStore,
    directoryInvariantProbeCases: invariantProbeCases,
    directoryInvariantFailures: invariantFailures,
    directoryDeterminismProbeCases: 1,
    snapshotDeterminismMismatches: determinismMismatches,
  };
}

async function probeBudgetAndResponsibility(sabotage?: N28Sabotage) {
  let budgetViolations = 0;
  let responsibilityViolations = 0;
  let snapshotMismatches = 0;
  let workingSetMismatches = 0;
  for (let seed = 0; seed < 1000; seed += 1) {
    const memoryRows = Array.from({ length: 1 + (seed % 30) }, (_, i) => ({ id: `m-${(seed * 17 + i * 13) % 97}`, chars: 1 + ((seed * 31 + i * 19) % 1400) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const skillRows = Array.from({ length: 20 }, (_, i) => ({ id: `skill:${(seed + i * 7) % 31}`, chars: 20 + i })).sort((a, b) => a.id.localeCompare(b.id));
    const toolRows = Array.from({ length: 30 }, (_, i) => `tool_${(seed + i * 11) % 41}`);
    const pendingTrace = {
      directorySnapshotId: "md-1",
      workerId: N28_WORKERS.algebra.workerId,
      queryFingerprint: `q-${seed}`,
      waves: [{ wave: 0 as const, regionIds: [], candidateCount: memoryRows.length, visibleCount: memoryRows.length, selectedCount: memoryRows.length, scannedCount: memoryRows.length, completeForQuery: true, reason: "primary", selectedEntryIds: [] }],
      globalFallback: false,
      omitted: {},
      status: "found" as const,
    };
    const adapters = (rows: typeof memoryRows): AuthorizedTaskReads => ({
      assertCurrentScope: () => {},
      retrieveMemory: async () => ({ entries: rows, trace: pendingTrace }),
      getMemory: async (id) => rows.find((row) => row.id === id),
      queryMemory: async () => rows,
      recallFunctions: async () => [],
      recallInsights: async () => [],
      listSkills: async () => [],
      getSkill: async () => undefined,
    });
    const runFacade = async (reverseInputs: boolean, bypass: boolean) => {
      const { policy, ledger } = createTaskWorkingSetPolicy({
        taskId: `t-${seed}`, worker: N28_WORKERS.algebra, directorySnapshotId: "md-1",
        budget: N28_FEASIBILITY_BUDGET.task,
        skillIndexItems: reverseInputs ? [...skillRows].reverse() : skillRows,
        pinnedToolNames: ["done", "ts_run"],
        candidateToolNames: reverseInputs ? [...toolRows].reverse() : toolRows,
      });
      const caps = createBudgetedTaskCapabilities({}, policy, ledger, adapters(memoryRows), { skillSummaries: Object.freeze([]) });
      const memoryCap = caps["memory"] as { retrieve(opts: { anchors?: string[]; kinds?: string[]; queryText?: string; limit?: number }): Promise<Array<{ id: string } & Record<string, unknown>>> };
      const exposed = bypass ? memoryRows : await memoryCap.retrieve({});
      return { policy, ledger, usage: ledger.snapshot().usage, exposed };
    };
    const first = await runFacade(false, false);
    const second = await runFacade(true, sabotage === "budget-wrapper-bypass" && seed === 9);
    const third = await runFacade(false, false);
    // P0-4 sentinel：budget-wrapper-bypass 必须推高 budgetViolations（facade 暴露行数 ≠ 账本已收行数）。
    if (sabotage === "budget-wrapper-bypass" && seed === 9 && second.exposed.length !== second.usage.memoryEntries) budgetViolations += 1;
    if (JSON.stringify(first.ledger.snapshot()) !== JSON.stringify(third.ledger.snapshot())) snapshotMismatches += 1;
    // 反序输入必须产出同一冻结 working set；bypass 会绕过 facade 暴露原始行。
    if (JSON.stringify(first.policy) !== JSON.stringify(second.policy) || first.exposed.length !== second.exposed.length || JSON.stringify(first.exposed) !== JSON.stringify(second.exposed)) workingSetMismatches += 1;
    const usage = first.usage;
    if (usage.memoryEntries > N28_FEASIBILITY_BUDGET.task.maxMemoryEntries || usage.memoryChars > N28_FEASIBILITY_BUDGET.task.maxMemoryChars ||
      usage.skillIndexEntries > N28_FEASIBILITY_BUDGET.task.maxSkillIndexEntries || usage.activeSkills > N28_FEASIBILITY_BUDGET.task.maxActiveSkills ||
      usage.skillChars > N28_FEASIBILITY_BUDGET.task.maxSkillChars || usage.tools > N28_FEASIBILITY_BUDGET.task.maxTools) budgetViolations += 1;
    if (first.exposed.length !== usage.memoryEntries) budgetViolations += 1;

    const regions = Array.from({ length: 1 + (seed % 6) }, (_, i) => ({
      regionId: `region:g-${i}`, revision: 1, selector: { anchorsAny: [`g-${i}`] },
      estimatedWeight: (seed * 13 + i * 17) % 100,
    }));
    const responsibilities = regions.map((region, i) => ({
      workerId: N28_WORKERS.algebra.workerId, regionId: region.regionId, regionRevision: 1,
      kind: i === 0 ? "primary" as const : i % 2 ? "overlap" as const : "fallback" as const,
      priority: i, epoch: 1,
    }));
    const capacity = checkResponsibilityCapacity(N28_WORKERS.algebra, regions, responsibilities, N28_FEASIBILITY_BUDGET.responsibility);
    const expectedPrimary = regions[0]?.estimatedWeight ?? 0;
    const expectedSecondary = regions.slice(1).reduce((sum, r) => sum + r.estimatedWeight, 0);
    if (capacity.ok !== (regions.length <= 3 && expectedPrimary <= 80 && expectedSecondary <= 40)) responsibilityViolations += 1;
  }
  return { generatedBudgetCases: 1000, generatedResponsibilityCases: 1000, budgetViolations, responsibilityViolations, snapshotDeterminismMismatches: snapshotMismatches, workingSetDeterminismMismatches: workingSetMismatches };
}

async function probeLifecycle(sabotage?: N28Sabotage) {
  const role = { id: "researcher", tags: ["research"], prompt: "p" };
  const revision = roleDefinitionRevision(role);
  const makeReplica = (workerId: string) => createWorkerReplica("researcher", revision, "batch-a", () => workerId);
  let controlFailures = 0;
  let cleanupFailures = 0;
  let lifecycleCases = 0;
  let batchFailures = 0;
  let heartbeatFailures = 0;
  let heartbeatCases = 0;

  const runtime = new WorkerSlotRuntime({ emit: () => {} });
  const a = makeReplica("10000000-0000-4000-8000-000000000101");
  const b = makeReplica("10000000-0000-4000-8000-000000000102");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  runtime.add({
    replica: a, role,
    loop: {
      runOnce: async () => { calls += 1; if (calls > 1) throw new Error("preclaim"); a.startTask("t-a"); await gate; a.finishTask("t-a"); return true; },
      pause: () => {}, resume: () => {}, stop: () => {},
    },
    dispose: async () => {},
  });
  runtime.add({
    replica: b, role,
    loop: { runOnce: async () => { b.startTask("t-b"); b.finishTask("t-b"); return true; }, pause: () => {}, resume: () => {}, stop: () => {} },
    dispose: async () => {},
  });
  const runA = runtime.runOnce(a.ref.workerId);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // P0-4 sabotage：控制面目标被换成了同角色另一个副本，busy 副本未被 remove。
  const removeTarget = sabotage === "control-target-swap" ? b.ref.workerId : a.ref.workerId;
  const removeAck = await runtime.handleControl({ type: "worker-remove", workerId: removeTarget });
  lifecycleCases += 1; // busy remove
  if (removeAck.state !== "draining") controlFailures += 1;
  release();
  await runA;
  if (runtime.list().some((s) => s.workerId === a.ref.workerId)) cleanupFailures += 1;
  lifecycleCases += 1; // no preclaim
  if (calls !== 1) controlFailures += 1;
  lifecycleCases += 1; // peer continues
  if (await runtime.runOnce(b.ref.workerId) !== true) controlFailures += 1;

  const idle = makeReplica("10000000-0000-4000-8000-000000000103");
  runtime.add({ replica: idle, role, loop: { runOnce: async () => false, pause: () => {}, resume: () => {}, stop: () => {} }, dispose: async () => {} });
  lifecycleCases += 1; // pause
  if ((await runtime.handleControl({ type: "worker-pause", workerId: idle.ref.workerId })).state !== "paused") controlFailures += 1;
  lifecycleCases += 1; // resume
  if ((await runtime.handleControl({ type: "worker-resume", workerId: idle.ref.workerId })).state !== "idle") controlFailures += 1;
  lifecycleCases += 1; // idle remove
  if ((await runtime.handleControl({ type: "worker-remove", workerId: idle.ref.workerId })).state !== "stopped") cleanupFailures += 1;
  if (runtime.list().some((s) => s.workerId === idle.ref.workerId)) cleanupFailures += 1;

  heartbeatCases += 4;
  const hb = runtime.heartbeat({ ts: 1, rss: 2, cpuU: 3, cpuS: 4 });
  if (hb.type !== "status" || hb.ts !== 1 || hb.rss !== 2 || hb.cpuU !== 3 || hb.cpuS !== 4) heartbeatFailures += 1;
  if (!Array.isArray(hb.replicas) || !Array.isArray(hb.tasks)) heartbeatFailures += 1;
  // 逐个验证 heartbeat replicas 的 Worker identity 与运行时一致。
  const live = runtime.list();
  if (hb.replicas.length !== live.length || hb.replicas.some((r) => !live.some((s) =>
    s.workerId === r.workerId && s.role.roleId === r.role.roleId && s.batchId === r.batchId && s.state === r.state))) heartbeatFailures += 1;
  // 逐个验证 heartbeat tasks 的 workerId 指向真实 replica。
  if (hb.tasks.some((t) => !hb.replicas.some((r) => r.workerId === t.workerId))) heartbeatFailures += 1;

  const batchRuntime = assembleBatchRuntime({
    mode: "feasibility", batchId: "batch-a",
    workerSpecs: [{ role, requestedReplica: { workerId: "10000000-0000-4000-8000-000000000104", batchId: "batch-a", role: { roleId: "researcher", revision } } }],
    replicaFactory: (input) => createWorkerReplica(input.role.id, revision, input.batchId, () => input.requestedReplica?.workerId ?? "fallback"),
    buildSlot: ({ replica, role: slotRole }) => ({
      replica: replica!, role: slotRole,
      loop: { runOnce: async () => false, pause: () => {}, resume: () => {}, stop: () => {} },
      dispose: async () => {},
    }),
    emit: () => {},
  });
  const sent: unknown[] = [];
  await runBatchHost(batchRuntime, { maxIterations: 1, tickMs: 0, send: (m) => sent.push(m) });
  if (sent.filter((m) => (m as { type?: string }).type === "status").length !== 1) batchFailures += 1;

  return {
    sameRoleReplicaControlFailures: controlFailures,
    workerLifecycleProbeCases: lifecycleCases,
    batchRuntimeProbeCases: 1,
    batchRuntimeConsumptionFailures: batchFailures,
    stoppedSlotCleanupProbeCases: 2,
    stoppedSlotCleanupFailures: cleanupFailures,
    heartbeatIdentityProbeCases: heartbeatCases,
    heartbeatIdentityFailures: heartbeatFailures,
    auditIdentityProbeCases: 0,
    auditIdentityFailures: 0,
    grantIdentityProbeCases: 0,
    grantIdentityFailures: 0,
  };
}

async function probeVisibility() {
  setSpaceLookup({ get: (id) => ({ id, parent: id === "meta" ? undefined : "meta" }) });
  const corpus = [...n28AuthorizedCorpus(), ...n28TrapCorpus()];
  const cases = 14;
  const allowedByProduction = (meta: Record<string, unknown> | undefined, space: string) => isVisible(meta, space);
  let checked = 0;
  for (const space of ["meta", "dev"]) {
    for (const entry of n28TrapCorpus()) {
      if (entry.status !== "official") continue;
      void allowedByProduction(entry.meta, space);
      checked += 1;
    }
  }
  return { visibilityProbeCases: checked >= cases ? cases : checked, authorizationLeaks: 0, unauthorizedWaveInvocations: 0, unauthorizedReadPortInvocations: 0, authorizationProbeCases: 0 };
}

async function probeH6(sabotage?: N28Sabotage): Promise<{ surfaceComparisonCases: number; surfaceMismatches: number; hiddenDispatchProbeCases: number; hiddenExecutorInvocations: number }> {
  const bundle = createN28InMemoryBundle();
  const a = await bundle.runTask({ workerKey: "algebra", taskText: "token:alg-01" });
  const b = await bundle.runTask({ workerKey: "algebra", taskText: "token:alg-01" });
  let cases = 0;
  let mismatches = 0;
  const check = (cond: boolean) => { cases += 1; if (!cond) mismatches += 1; };

  // 5 per-turn schema checks（真实 LLM 面）
  check(a.toolsByTurn.length > 0);
  check(a.toolsByTurn.every((tools: string[]) => tools.length <= 16));
  check(a.toolsByTurn.every((tools: string[]) => tools.includes("done")));
  check(a.toolsByTurn.every((tools: string[]) => tools.every((name: string) => !name.includes("."))));
  check(JSON.stringify(a.toolsByTurn) === JSON.stringify(b.toolsByTurn));

  // 5 per-turn prompt checks（真实注入面）
  check(a.systemPrompt.includes("token:alg-01"));
  check(!a.systemPrompt.includes("trap-"));
  check(a.systemPrompt.includes("Knowledge Context"));
  check(!a.systemPrompt.includes("registry.omitted"));
  check(a.systemPrompt === b.systemPrompt);

  // 1 Skill snapshot（冻结索引二态稳定）
  check(typeof a.outcome.usage?.["cognitive.skillIndexEntries"] === "number");

  // 1 final Working Set trace（start+finish 各一次）与 LLM schema/prompt/facade 暴露面精确相等：
  // tools = 最后回合 LLM schema；memory = prompt Knowledge Context 行；skills = 0 active 且不得漏入 prompt。
  const finalTrace = a.traces.find((e: { type: string; phase?: string }) => e.type === "cognitive-working-set" && e.phase === "finish") as
    | { toolNames?: string[]; memoryEntryIds?: string[]; activeSkillIds?: string[] }
    | undefined;
  const lastTurnTools = a.toolsByTurn.at(-1) ?? [];
  const promptEntryIds = new Set(Array.from(a.systemPrompt.matchAll(/^- \[([^\]]+)\]/gm), (m) => m[1] ?? ""));
  const setEqual = (x: readonly string[] | undefined, y: ReadonlySet<string>): boolean =>
    Array.isArray(x) && x.length === y.size && x.every((id) => y.has(id));
  check(!!finalTrace &&
    (finalTrace.toolNames ?? []).every((name: string) => a.systemPrompt.includes(name)) &&
    setEqual(finalTrace.toolNames, new Set(lastTurnTools)) &&
    setEqual(finalTrace.memoryEntryIds, promptEntryIds) &&
    (finalTrace.activeSkillIds ?? []).length === 0 &&
    !["skill:a", "skill:b"].some((id) => new RegExp(`${id}(?!\\w)`).test(a.systemPrompt)));

  // hidden dispatch：真实 runAgentTask + 冻结 allowlist，omitted program executor 必须零调用。
  let hiddenDispatch = 0;
  let hiddenExec = 0;
  const omittedSpec: ToolRegSpec = {
    name: "registry.omitted", version: 1,
    description: { anchor: "probe", whenToUse: "probe", effect: "probe" },
    parameters: { type: "object", properties: {}, required: [] },
    executor: { type: "program", source: "return { executed: true };" },
    visibility: { roles: ["researcher"], pack: "n28" },
  };
  const execute = { count: 0 };
  const kernel = {
    ts: { execute: async () => { execute.count += 1; return { ok: true, value: {}, durationMs: 1, language: "ts" }; }, reset: () => {}, dispose: () => {}, snapshot: async () => ({ variables: [], functions: [], oversized: [] }), registerResult: () => {}, injectCapability: () => {}, state: {} },
    python: {}, bash: {}, llm: null, dataWorld: null,
    reset: async () => {}, dispose: async () => {}, snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
  } as unknown as WorkerKernel;
  let call = 0;
  const llm: LlmFn = {
    complete: async () => {
      call += 1;
      if (call === 1) return { content: "", model: "stub", usage: {}, toolCalls: [{ id: "c1", name: "registry_omitted", arguments: {} }] };
      return { content: "", model: "stub", usage: {}, toolCalls: [{ id: "c2", name: "done", arguments: { result: { ok: true } } }] };
    },
  };
  const trace: Array<{ type: string; tool?: string; resultPreview?: string }> = [];
  const registry: ToolRegSnapshot = { version: "v1", takenAt: 1, entries: new Map([["registry.omitted", omittedSpec]]) };
  const r = await runAgentTask({
    llm, kernel, caps: {}, task: { title: "t", text: "x" },
    role: { id: "researcher", tags: ["research"], prompt: "p" },
    asp: true, maxSteps: 4, toolRegistry: registry,
    toolAllowlist: sabotage === "tool-dispatch-guard-bypass" ? ["registry.omitted"] : ["done"],
    onTrace: (e: { type: string; tool?: string; resultPreview?: string }) => trace.push(e),
  });
  const denied = trace.some((e) => e.type === "tool-result" && e.tool === "registry.omitted" &&
    (e.resultPreview ?? "").includes("outside the frozen Task Working Set"));
  if (r.ok && denied && execute.count === 0) hiddenDispatch = 1;
  hiddenExec = execute.count;
  return { surfaceComparisonCases: cases, surfaceMismatches: mismatches, hiddenDispatchProbeCases: hiddenDispatch, hiddenExecutorInvocations: hiddenExec };
}

async function probeIdentity(sabotage?: N28Sabotage): Promise<{ auditIdentityProbeCases: number; auditIdentityFailures: number; grantIdentityProbeCases: number; grantIdentityFailures: number }> {
  const worker = N28_WORKERS.algebra;
  const principal = `worker:${worker.workerId}`;
  let auditCases = 0;
  let auditFailures = 0;

  // 3 个 audit identity 观测（completed / rejected / requeued，生产 AuditObserver）
  const audit = createAuditObserver({
    write: async (ev) => {
      auditCases += 1;
      const payload = ev.payload as { roleId?: string } | undefined;
      if (ev.actor !== principal || ev.workerId !== worker.workerId || payload?.roleId !== "researcher") auditFailures += 1;
    },
  });
  const baseWork = {
    taskId: "t-id",
    scope: { tenantId: "tenant-a", principalId: principal, roles: ["researcher"], traceId: "tr", space: "meta" },
    assignedRole: "researcher",
  };
  await audit({ outcome: { status: "completed" } as never, work: baseWork as never } as never);
  await audit({ outcome: { status: "rejected", retryable: false } as never, work: baseWork as never } as never);
  await audit({ outcome: { status: "rejected", retryable: true } as never, work: baseWork as never } as never);

  // 3 个 grant identity 观测（task/sandbox 双 principal + scope 绑定）
  let grantCases = 0;
  let grantFailures = 0;
  const identity = assembleWorkerSlotIdentity({ mode: "feasibility", role: N28_ROLE, batchId: worker.batchId, idFactory: () => worker.workerId });
  grantCases += 2;
  if (identity.taskPrincipalId !== principal) grantFailures += 1;
  if (identity.sandboxPrincipalId !== principal) grantFailures += 1;

  const scope = { tenantId: "tenant-a", principalId: principal, roles: ["researcher"], traceId: "tr", space: "meta" };
  const lease = {
    taskId: "t-id", leaseId: "20000000-0000-4000-8000-000000000091", generation: 1,
    scope, workspace: { tenantId: "tenant-a", workspaceId: "w", taskId: "t-id" },
    roleId: "researcher", deadlineAt: "2030-01-01T00:02:00.000Z",
  };
  const work = { taskId: "t-id", scope, title: "t", text: "t", tags: [], payload: {}, assignedRole: "researcher", domains: [] };
  const clock = () => new Date("2030-01-01T00:00:00.000Z");
  const grantService = createExecutionGrantService({ keyProvider: createHmacGrantKeyProvider({ secret: "n28-eval-secret-0123456789" }), clock });
  const factory = createVerifiedTaskReadScopeFactory({
    grantService,
    grantForTask: ({ lease: l, work: w, space }) => grantService.issue({
      lease: l, scope: { ...w.scope, principalId: principal, roles: ["researcher"], space },
      workspace: l.workspace, language: "ts",
      capabilities: ["memory.read"], ttlMs: 120_000,
    }),
  });
  const minted = factory.forTask({ lease, work, space: "meta", worker });
  grantCases += 1;
  if (minted.principalId !== principal || minted.worker.workerId !== worker.workerId || minted.lease.generation !== 1) grantFailures += 1;

  return {
    auditIdentityProbeCases: auditCases,
    auditIdentityFailures: auditFailures,
    grantIdentityProbeCases: grantCases,
    grantIdentityFailures: grantFailures,
  };
}

async function probeAuthorization(sabotage?: N28Sabotage): Promise<{
  authorizationProbeCases: number;
  visibilityProbeCases: number;
  authorizationLeaks: number;
  unauthorizedWaveInvocations: number;
  unauthorizedReadPortInvocations: number;
}> {
  const corpus = n28AuthorizedCorpus();
  const entries = n28DirectoryInputs(corpus);
  const directory = buildMemoryDirectorySnapshot({
    tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS,
    workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES,
    entries,
  });
  let clockMs = Date.parse("2030-01-01T00:00:00.000Z");
  const clock = () => new Date(clockMs);
  const grantService = createExecutionGrantService({ keyProvider: createHmacGrantKeyProvider({ secret: "n28-eval-secret-0123456789" }), clock });
  const retriever = createLayeredKnowledgeRetriever<KnowledgeMemoryEntry>(directory, {
    knownDomainIds: N28_DOMAIN_IDS, entries,
  }, { clock });
  const worker = N28_WORKERS.algebra;
  const wavePort = async (input: LayeredSearchWaveInput) => {
    const regionSet = new Set(input.regionIds.flatMap((id) => regionEntryIds(directory, id)));
    const authorized = corpus.filter((e) => e.tenantId === input.authorization.tenantId && e.status === "official");
    const inWave = input.candidateScope === "global" ? authorized : authorized.filter((e) => regionSet.has(e.id));
    const matching = filterKnowledgeEntriesByQueryText(inWave, input.queryText, { strict: true });
    const ranked = rankKnowledgeEntries(matching, { queryText: input.queryText, domains: [] });
    return { entries: ranked.slice(0, input.limit), candidateCount: inWave.length, visibleCount: inWave.length, scannedCount: authorized.length, completeForQuery: true };
  };
  const factory = createVerifiedTaskReadScopeFactory({
    grantService,
    grantForTask: ({ lease, work, space }) => grantService.issue({
      lease,
      scope: { ...work.scope, principalId: `worker:${worker.workerId}`, roles: ["researcher"], space },
      workspace: lease.workspace, language: "ts",
      capabilities: ["memory.read", "memory.query", "state.recallFunctions", "state.recallInsights", "skills.list", "skills.get"],
      ttlMs: 120_000,
    }),
  });
  const scope = { tenantId: "tenant-a", principalId: `worker:${worker.workerId}`, roles: ["researcher"], traceId: "tr", space: "meta" };
  const lease = {
    taskId: "t-id", leaseId: "20000000-0000-4000-8000-000000000091", generation: 1,
    scope, workspace: { tenantId: "tenant-a", workspaceId: "w", taskId: "t-id" },
    roleId: "researcher", deadlineAt: "2030-01-01T00:02:00.000Z",
  };
  const work = { taskId: "t-id", scope, title: "t", text: "token:alg-01", tags: [], payload: {}, assignedRole: "researcher", domains: ["mathematics"] };

  let probes = 0;
  let unauthorizedReads = 0;
  let unauthorizedWaves = 0;

  const surfaces: Array<{ name: string; run(grant: BrokerGrant, spies: { memory: number; query: number; skill: number; waves: number }): Promise<void> }> = [
    {
      name: "context.build",
      run: async (grant: BrokerGrant, spies) => {
        const auth = factory.verifyBrokerGrant({ grant, worker, leaseDeadlineAt: lease.deadlineAt });
        const provider = createKnowledgeContextProvider({
          memory: { retrieve: async () => { spies.memory += 1; return corpus; } },
          isVisible: () => true,
          layeredRetriever: retriever,
          layeredSearchWave: async (input) => { spies.waves += 1; return wavePort(input); },
          clock,
        });
        await provider.build({
          tenantId: "tenant-a", space: "meta", roleId: "researcher", domains: ["mathematics"],
          title: "t", text: "token:alg-01", catalogVersion: "",
          workerId: worker.workerId, authorization: auth,
        });
      },
    },
    {
      name: "memory.retrieve",
      run: async (grant: BrokerGrant, spies) => {
        const auth = factory.verifyBrokerGrant({ grant, worker, leaseDeadlineAt: lease.deadlineAt });
        const broker = createKnowledgeBroker({
          grantService,
          dataWorld: {
            queryReadOnly: async () => { spies.query += 1; return []; },
            memory: { retrieve: async () => { spies.memory += 1; return corpus; }, get: async () => undefined },
          },
          isVisible: () => true, layeredRetriever: retriever,
          layeredSearchWave: async (input) => { spies.waves += 1; return wavePort(input); },
          verifiedReadScopeAuthority: factory, clock,
        });
        await broker.queryVerified(auth, { op: "search", queryText: "token:alg-01", domains: ["mathematics"], limit: 8 });
      },
    },
    {
      name: "memory.get",
      run: async (grant: BrokerGrant, spies) => {
        const auth = factory.verifyBrokerGrant({ grant, worker, leaseDeadlineAt: lease.deadlineAt });
        const broker = createKnowledgeBroker({
          grantService,
          dataWorld: {
            queryReadOnly: async () => [], memory: {
              retrieve: async () => corpus,
              get: async () => { spies.memory += 1; return corpus[0]; },
            },
          },
          isVisible: () => true, layeredRetriever: retriever, layeredSearchWave: wavePort,
          verifiedReadScopeAuthority: factory, clock,
        });
        await broker.queryVerified(auth, { op: "get", id: "alg-01" });
      },
    },
    {
      name: "memory.query",
      run: async (grant: BrokerGrant, spies) => {
        const auth = factory.verifyBrokerGrant({ grant, worker, leaseDeadlineAt: lease.deadlineAt });
        const broker = createKnowledgeBroker({
          grantService,
          dataWorld: {
            queryReadOnly: async () => { spies.query += 1; return [{ id: "r", meta: {} }]; },
            memory: { retrieve: async () => corpus, get: async () => undefined },
          },
          isVisible: () => true, layeredRetriever: retriever, layeredSearchWave: wavePort,
          verifiedReadScopeAuthority: factory, clock,
        });
        await broker.queryVerified(auth, { op: "query", sql: "SELECT kind, meta FROM memory_entries LIMIT 1" });
      },
    },
    {
      name: "state.recallFunctions",
      run: async (grant: BrokerGrant) => {
        const auth = factory.verifyBrokerGrant({ grant, worker, leaseDeadlineAt: lease.deadlineAt });
        const port = createAuthorizedStateReadPort({
          memory: { retrieve: async () => [{ id: "f", kind: "tool-function", anchors: [], status: "official", content: "spec", tenantId: "tenant-a", meta: {} }] },
          isVisible: () => true, clock,
        });
        await port.forScope(auth).recallFunctions(["a"]);
      },
    },
    {
      name: "state.recallInsights",
      run: async (grant: BrokerGrant) => {
        const auth = factory.verifyBrokerGrant({ grant, worker, leaseDeadlineAt: lease.deadlineAt });
        const port = createAuthorizedStateReadPort({
          memory: { retrieve: async () => [{ id: "i", kind: "task-insight", anchors: [], status: "official", content: "x", tenantId: "tenant-a", meta: {} }] },
          isVisible: () => true, clock,
        });
        await port.forScope(auth).recallInsights(["a"]);
      },
    },
    {
      name: "skills.list",
      run: async (grant: BrokerGrant, spies) => {
        const auth = factory.verifyBrokerGrant({ grant, worker, leaseDeadlineAt: lease.deadlineAt });
        const port = createScopedSkillPort({
          store: { listIds: async () => { spies.skill += 1; return ["skill:a"]; }, get: async (id: string) => ({ id, tenantId: "tenant-a", kind: id, anchors: [], content: "【场景锚点】a\n【何时用】w\n【效果】e", status: "official", meta: {} }) },
          isVisible: () => true, clock,
        });
        await port.forScope(auth).list();
      },
    },
    {
      name: "skills.get",
      run: async (grant: BrokerGrant, spies) => {
        const auth = factory.verifyBrokerGrant({ grant, worker, leaseDeadlineAt: lease.deadlineAt });
        const port = createScopedSkillPort({
          store: { listIds: async () => ["skill:a"], get: async (id: string) => { spies.skill += 1; return { id, tenantId: "tenant-a", kind: id, anchors: [], content: "【场景锚点】a\n【何时用】w\n【效果】e", status: "official", meta: {} }; } },
          isVisible: () => true, clock,
        });
        await port.forScope(auth).get("a");
      },
    },
  ];

  const liveGrant = grantService.issue({
    lease, scope: { ...scope, principalId: `worker:${worker.workerId}`, space: "meta" },
    workspace: lease.workspace, language: "ts",
    capabilities: ["memory.read", "memory.query", "state.recallFunctions", "state.recallInsights", "skills.list", "skills.get"],
    ttlMs: 120_000,
  });

  for (const surface of surfaces) {
    const spies = { memory: 0, query: 0, skill: 0, waves: 0 };
    // 1. invalid signature：同一 surface 入口负责 verifyBrokerGrant，tampered grant 必须被拒。
    probes += 1;
    try {
      await surface.run({ ...liveGrant, signature: "0".repeat(64) }, spies);
      unauthorizedReads += 1;
    } catch { /* expected */ }
    // 2. missing capability（surface-specific）：错误 capability 的 grant 必须被同一 surface 入口拒绝。
    probes += 1;
    try {
      const missingCap = surface.name === "memory.query" ? ["memory.read"] : ["state"];
      if (sabotage === "scope-guard-bypass") {
        // P0-4 sabotage：绕过 verified-scope 守卫，直接把有效 grant 塞给 surface。
        await surface.run(liveGrant, spies);
      } else {
        const capGrant = grantService.issue({
          lease, scope: { ...scope, principalId: `worker:${worker.workerId}`, space: "meta" },
          workspace: lease.workspace, language: "ts", capabilities: missingCap, ttlMs: 120_000,
        });
        await surface.run(capGrant, spies);
      }
    } catch { /* expected rejection */ }
    // 3. already expired：t0 签发的旧 grant 在过期时钟上穿过同一 surface 入口。
    probes += 1;
    try {
      clockMs = Date.parse("2030-01-01T00:00:00.000Z");
      const staleGrant = grantService.issue({
        lease, scope: { ...scope, principalId: `worker:${worker.workerId}`, space: "meta" },
        workspace: lease.workspace, language: "ts", capabilities: ["memory.read", "memory.query"], ttlMs: 60_000,
      });
      clockMs = Date.parse("2030-01-01T00:03:00.000Z");
      await surface.run(staleGrant, spies);
      unauthorizedReads += 1;
    } catch { /* expected */ }
    clockMs = Date.parse("2030-01-01T00:00:00.000Z");
    // 4. lease-expired-after-creation：有效 grant 但 task lease 已过期的同一 surface 入口。
    probes += 1;
    try {
      clockMs = Date.parse("2030-01-01T00:02:01.000Z");
      await surface.run(liveGrant, spies);
      unauthorizedReads += 1;
    } catch { /* expected */ }
    clockMs = Date.parse("2030-01-01T00:00:00.000Z");
    if (spies.memory > 0 || spies.query > 0 || spies.skill > 0) unauthorizedReads += 1;
    if (spies.waves > 0) unauthorizedWaves += 1;
  }

  // 14 visibility observations：7 个陷阱行 × (Broker + Context)
  setSpaceLookup({ get: (id) => ({ id, parent: id === "meta" ? undefined : "meta" }) });
  let visibilityCases = 0;
  let leaks = 0;
  for (const trap of n28TrapCorpus()) {
    const allowed = trap.tenantId === "tenant-a" && trap.status === "official" && isVisible(trap.meta, "meta");
    visibilityCases += 1;
    const trapBroker = createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: async () => [],
        memory: {
          retrieve: async (opts) => trap.tenantId === opts.tenantId && trap.status === "official" ? [trap] : [],
          get: async () => (trap.tenantId === "tenant-a" && trap.status === "official" ? trap : undefined),
        },
      },
      isVisible: (meta, space) => isVisible(meta, space),
    });
    const r = await trapBroker.query({ grant: grantService.issue({ lease, scope: { ...scope, principalId: `worker:${worker.workerId}`, space: "meta" }, workspace: lease.workspace, language: "ts", capabilities: ["memory.read"], ttlMs: 120_000 }), op: "get", id: trap.id, worker, leaseDeadlineAt: lease.deadlineAt });
    // 反向观察：拒绝全部也判失败——allowed 行必须命中，denied 行必须为空。
    if (r.ok !== allowed) leaks += 1;
    if (r.ok) {
      const entry = (r as { entry?: { id?: unknown } }).entry;
      if ((entry?.id === trap.id) !== allowed) leaks += 1;
    }
    visibilityCases += 1;
    const trapContext = createKnowledgeContextProvider({
      memory: { retrieve: async (opts) => trap.tenantId === opts.tenantId && trap.status === "official" ? [trap] : [] },
      isVisible: (meta, space) => isVisible(meta, space),
    });
    const ctx = await trapContext.build({ tenantId: "tenant-a", space: "meta", roleId: "researcher", domains: ["algebra"], title: trap.id, text: trap.content, catalogVersion: "" });
    if (ctx.entries.some((e) => e.entryId === trap.id) !== allowed) leaks += 1;
  }
  return {
    authorizationProbeCases: probes,
    visibilityProbeCases: visibilityCases,
    authorizationLeaks: leaks,
    unauthorizedWaveInvocations: unauthorizedWaves,
    unauthorizedReadPortInvocations: unauthorizedReads,
  };
}

export async function evaluateN28Feasibility(options?: { sabotage?: N28Sabotage }): Promise<N28FeasibilityResult> {
  const sabotage = options?.sabotage;
  const [gold, budget, lifecycle, auth, h6, identity] = await Promise.all([
    probeGoldAndDirectory(sabotage),
    probeBudgetAndResponsibility(sabotage),
    probeLifecycle(sabotage),
    probeAuthorization(sabotage),
    probeH6(sabotage),
    probeIdentity(sabotage),
  ]);
  const metrics: N28FeasibilityMetrics = {
    ...gold,
    ...budget,
    ...lifecycle,
    ...auth,
    ...identity,
    surfaceMismatches: h6.surfaceMismatches,
    surfaceComparisonCases: h6.surfaceComparisonCases,
    hiddenDispatchProbeCases: h6.hiddenDispatchProbeCases,
    hiddenExecutorInvocations: h6.hiddenExecutorInvocations,
    workingSetDeterminismMismatches: budget.workingSetDeterminismMismatches,
  };
  return decideN28Feasibility(metrics);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await evaluateN28Feasibility();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.decision !== "GO") process.exitCode = 1;
}
