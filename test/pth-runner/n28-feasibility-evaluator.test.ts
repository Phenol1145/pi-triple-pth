import { describe, expect, it } from "vitest";
import {
  METRIC_KEYS, decideN28Feasibility, evaluateN28Feasibility,
  validateN28FeasibilityMetrics, type N28FeasibilityMetrics,
} from "../../scripts/eval-n28-feasibility.js";

function passingMetricsFixture(): N28FeasibilityMetrics {
  return {
    goldQueries: 12, goldFoundQueries: 12, fourWaveCases: 12, goldRecall: 1,
    authorizationLeaks: 0, maxRetrievalWaves: 4, generatedBudgetCases: 1000,
    generatedResponsibilityCases: 1000, budgetViolations: 0, sameRoleReplicaControlFailures: 0,
    workerLifecycleProbeCases: 6, batchRuntimeProbeCases: 1, batchRuntimeConsumptionFailures: 0,
    stoppedSlotCleanupProbeCases: 2, stoppedSlotCleanupFailures: 0,
    heartbeatIdentityProbeCases: 4, heartbeatIdentityFailures: 0,
    auditIdentityProbeCases: 3, auditIdentityFailures: 0,
    grantIdentityProbeCases: 3, grantIdentityFailures: 0,
    directoryCoverage: 1, memoryTypesCovered: 4, canonicalBodyEntries: 100,
    directoryMembershipReferences: 112, overlapMemberships: 2, ownerlessRegions: 0,
    bodyCopiesOutsideCanonicalStore: 0, directoryInvariantFailures: 0,
    directoryInvariantProbeCases: 8, directoryDeterminismProbeCases: 1,
    snapshotDeterminismMismatches: 0, workingSetDeterminismMismatches: 0,
    responsibilityViolations: 0, retrievalIncompleteCases: 0, retrievalFailedCases: 0,
    maxWaveSelectedCount: 20, missingFourWaveCases: 0, unauthorizedWaveInvocations: 0,
    unauthorizedReadPortInvocations: 0, authorizationProbeCases: 32, visibilityProbeCases: 14,
    surfaceMismatches: 0, surfaceComparisonCases: 12, hiddenDispatchProbeCases: 1, hiddenExecutorInvocations: 0,
  };
}

describe("N28 feasibility evaluator（纯判定）", () => {
  it("passing fixture 机械判 GO；每个 metric 坏值判 NO-GO；缺字段判 NO-GO", () => {
    const observed = passingMetricsFixture();
    expect(decideN28Feasibility(observed).decision).toBe("GO");
    const bad: Record<keyof N28FeasibilityMetrics, number> = Object.fromEntries(METRIC_KEYS.map((key) => {
      if (key === "goldQueries") return [key, 0];
      if (key === "goldFoundQueries") return [key, 0];
      if (key === "fourWaveCases") return [key, 0];
      if (key === "goldRecall" || key === "directoryCoverage") return [key, 0];
      if (key === "maxRetrievalWaves") return [key, 9];
      if (key === "maxWaveSelectedCount") return [key, 21];
      if (key === "directoryMembershipReferences") return [key, 0];
      if (key === "overlapMemberships") return [key, 0];
      if (key === "canonicalBodyEntries") return [key, 0];
      if (key === "memoryTypesCovered") return [key, 0];
      if (key.endsWith("ProbeCases") || key === "visibilityProbeCases" || key === "authorizationProbeCases") return [key, 0];
      if (key === "generatedBudgetCases" || key === "generatedResponsibilityCases") return [key, 0];
      return [key, 1];
    })) as Record<keyof N28FeasibilityMetrics, number>;
    expect(Object.keys(bad).sort()).toEqual([...METRIC_KEYS].sort());
    for (const metric of METRIC_KEYS) {
      const mutated = structuredClone(observed);
      mutated[metric] = bad[metric];
      expect(decideN28Feasibility(mutated).decision, metric).toBe("NO-GO");
    }
    const missing = structuredClone(observed) as Partial<N28FeasibilityMetrics>;
    delete missing.goldQueries;
    expect(decideN28Feasibility(missing as N28FeasibilityMetrics).decision).toBe("NO-GO");
  });

  it("结构校验：NaN/Infinity/-1 与未知字段被拒绝", () => {
    const observed = passingMetricsFixture();
    for (const invalid of [NaN, Infinity, -1]) {
      expect(validateN28FeasibilityMetrics({ ...observed, goldQueries: invalid })).not.toEqual([]);
    }
    expect(validateN28FeasibilityMetrics({ ...observed, extraField: 1 } as unknown)).not.toEqual([]);
  });

  it("unsabotaged 运行不硬编码决定：现有证据面诚实出 NO-GO，且 H2/H3/H5/H6 为 true", async () => {
    const result = await evaluateN28Feasibility();
    expect(result.decision).toBe("NO-GO");
    expect(result.metrics.goldQueries).toBe(12);
    expect(result.metrics.generatedBudgetCases).toBe(1000);
    expect(result.hypotheses.H2.passed).toBe(true);
    expect(result.hypotheses.H3.passed).toBe(true);
    expect(result.hypotheses.H5.passed).toBe(true);
    expect(result.hypotheses.H6.passed).toBe(true);
    expect(result.hypotheses.H1.passed || result.hypotheses.H4.passed).toBe(false);
  });
});
