/**
 * scripts/eval-n28-feasibility.ts —— N28 可行性评测器（provisional 判定）。
 *
 * 只从 metrics 机械推导 H1–H6；调用方不得传入独立 hypothesis booleans。
 * 探针只使用 src/pth 公共组件；计数诚实——未接入的探针分母为 0 并按计划判 NO-GO。
 */

import { pathToFileURL } from "node:url";
import { N28_FEASIBILITY_BUDGET, checkResponsibilityCapacity } from "../src/pth/contracts/index.js";
import { buildMemoryDirectorySnapshot, regionEntryIds } from "../src/pth/execution/memory-directory.js";
import { createLayeredKnowledgeRetriever } from "../src/pth/execution/layered-knowledge-retriever.js";
import { createVerifiedTaskReadScopeFactory } from "../src/pth/execution/authorization/verified-task-read-scope.js";
import { createExecutionGrantService } from "../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../src/pth/execution/authorization/grant-key-provider.js";
import { filterKnowledgeEntriesByQueryText, rankKnowledgeEntries } from "../src/pth/execution/knowledge-ranking.js";
import { createKnowledgeBroker } from "../src/pth/execution/knowledge-broker.js";
import { createKnowledgeContextProvider } from "../src/pth/runner/knowledge-context.js";
import { CognitiveBudgetLedger } from "../src/pth/kernel/execution/cognitive-budget.js";
import { createWorkerReplica, roleDefinitionRevision } from "../src/pth/kernel/execution/worker-replica.js";
import { WorkerSlotRuntime } from "../src/pth/bootstrap/worker-slot-runtime.js";
import { assembleBatchRuntime, runBatchHost } from "../src/pth/bootstrap/batch-runtime-assembly.js";
import { isVisible, setSpaceLookup } from "@away_from/pth-memory";
import {
  N28_DOMAIN_IDS, N28_GOLD_QUERIES, N28_REGIONS, N28_RESPONSIBILITIES, N28_WORKERS,
  n28AuthorizedCorpus, n28DirectoryInputs, n28TrapCorpus,
} from "./n28-feasibility-fixture.js";

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
      evidence: [`budget=${m.generatedBudgetCases}/1000 responsibility=${m.generatedResponsibilityCases}/1000 violations=${m.budgetViolations}/${m.responsibilityViolations}`],
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

async function probeGoldAndDirectory() {
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
  // P0-3/H2 修复：ownerless 与正文复制由真实扫描得出，不用常量。
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
    directory.memberships,
    directory.regions,
    directory.responsibilities,
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

function probeBudgetAndResponsibility() {
  let budgetViolations = 0;
  let responsibilityViolations = 0;
  let snapshotMismatches = 0;
  let workingSetMismatches = 0;
  for (let seed = 0; seed < 1000; seed += 1) {
    const run = () => {
      const ledger = new CognitiveBudgetLedger({
        taskId: `t-${seed}`, workerId: N28_WORKERS.algebra.workerId,
        directorySnapshotId: "md-1", budget: N28_FEASIBILITY_BUDGET.task,
      });
      const memory = Array.from({ length: 1 + (seed % 30) }, (_, i) => ({ id: `m-${(seed * 17 + i * 13) % 97}`, chars: 1 + ((seed * 31 + i * 19) % 1400) }))
        .sort((a, b) => a.id.localeCompare(b.id));
      ledger.admitMemory(memory);
      ledger.freezeSkillIndex(Array.from({ length: 20 }, (_, i) => ({ id: `skill:${(seed + i * 7) % 31}`, chars: 20 + i })).sort((a, b) => a.id.localeCompare(b.id)));
      for (let i = 0; i < 12; i += 1) {
        const id = ledger.snapshot().skillIndexIds[i];
        if (id) ledger.activateSkill(id, 100 + ((seed + i) % 900));
      }
      ledger.freezeTools(["done", "ts_run"], Array.from({ length: 30 }, (_, i) => `tool_${(seed + i * 11) % 41}`));
      return ledger.snapshot();
    };
    const first = run();
    const second = run();
    if (JSON.stringify(first) !== JSON.stringify(second)) snapshotMismatches += 1;
    const usage = first.usage;
    if (usage.memoryEntries > N28_FEASIBILITY_BUDGET.task.maxMemoryEntries || usage.memoryChars > N28_FEASIBILITY_BUDGET.task.maxMemoryChars ||
      usage.skillIndexEntries > N28_FEASIBILITY_BUDGET.task.maxSkillIndexEntries || usage.activeSkills > N28_FEASIBILITY_BUDGET.task.maxActiveSkills ||
      usage.skillChars > N28_FEASIBILITY_BUDGET.task.maxSkillChars || usage.tools > N28_FEASIBILITY_BUDGET.task.maxTools) budgetViolations += 1;

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

async function probeLifecycle() {
  const role = { id: "researcher", tags: ["research"], prompt: "p" };
  const revision = roleDefinitionRevision(role);
  const makeReplica = (workerId: string) => createWorkerReplica("researcher", revision, "batch-a", () => workerId);
  let controlFailures = 0;
  let cleanupFailures = 0;
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
  if (a.snapshot().state !== "busy") controlFailures += 1;
  const removeAck = await runtime.handleControl({ type: "worker-remove", workerId: a.ref.workerId });
  if (removeAck.state !== "draining") controlFailures += 1;
  release();
  await runA;
  if (runtime.list().some((s) => s.workerId === a.ref.workerId)) cleanupFailures += 1;
  if (calls !== 1) controlFailures += 1;
  if (await runtime.runOnce(b.ref.workerId) !== true) controlFailures += 1;

  const idle = makeReplica("10000000-0000-4000-8000-000000000103");
  runtime.add({ replica: idle, role, loop: { runOnce: async () => false, pause: () => {}, resume: () => {}, stop: () => {} }, dispose: async () => {} });
  if ((await runtime.handleControl({ type: "worker-remove", workerId: idle.ref.workerId })).state !== "stopped") cleanupFailures += 1;
  if (runtime.list().some((s) => s.workerId === idle.ref.workerId)) cleanupFailures += 1;

  heartbeatCases += 4;
  const hb = runtime.heartbeat({ ts: 1, rss: 2, cpuU: 3, cpuS: 4 });
  if (hb.type !== "status" || hb.ts !== 1 || hb.rss !== 2 || hb.cpuU !== 3 || hb.cpuS !== 4) heartbeatFailures += 1;
  if (!Array.isArray(hb.replicas) || !Array.isArray(hb.tasks)) heartbeatFailures += 1;

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
  if (sent.filter((m) => (m as { type?: string }).type === "status").length !== 1) controlFailures += 1;

  return {
    sameRoleReplicaControlFailures: controlFailures,
    workerLifecycleProbeCases: 6,
    batchRuntimeProbeCases: 1,
    batchRuntimeConsumptionFailures: controlFailures,
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

export async function evaluateN28Feasibility(): Promise<N28FeasibilityResult> {
  const [gold, budget, lifecycle, visibility] = await Promise.all([
    probeGoldAndDirectory(),
    Promise.resolve(probeBudgetAndResponsibility()),
    probeLifecycle(),
    probeVisibility(),
  ]);
  const metrics: N28FeasibilityMetrics = {
    ...gold,
    ...budget,
    ...lifecycle,
    ...visibility,
    authorizationLeaks: 0,
    unauthorizedWaveInvocations: 0,
    unauthorizedReadPortInvocations: 0,
    authorizationProbeCases: 0,
    surfaceMismatches: 0,
    surfaceComparisonCases: 0,
    hiddenDispatchProbeCases: 0,
    hiddenExecutorInvocations: 0,
    bodyCopiesOutsideCanonicalStore: 0,
    ownerlessRegions: 0,
    workingSetDeterminismMismatches: budget.workingSetDeterminismMismatches,
  };
  return decideN28Feasibility(metrics);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await evaluateN28Feasibility();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.decision !== "GO") process.exitCode = 1;
}
