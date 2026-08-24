import { describe, it, expect } from "vitest";
import { gradeRun, scoreScenario, buildReport, type BenchRunRecord, type BenchGrader } from "../../src/pth/bench/core.js";

describe("PTH Bench W0 core", () => {
  const rec: BenchRunRecord = {
    scenarioId: "calc-sum-ts",
    repeat: 1,
    startedAt: "2026-08-24T00:00:00.000Z",
    status: "completed",
    timing: { totalMs: 500, execMs: 420 },
    value: { sum: 5050 },
    usage: { inputTokens: 100, outputTokens: 50 },
  };

  it("status/value/latency/tokens grader 判定", () => {
    expect(gradeRun(rec, { kind: "status", expect: "completed" }).pass).toBe(true);
    expect(gradeRun(rec, { kind: "value", path: "sum", equals: 5050 }).pass).toBe(true);
    expect(gradeRun(rec, { kind: "latency", maxMs: 1000 }).pass).toBe(true);
    expect(gradeRun(rec, { kind: "latency", maxMs: 400, field: "execMs" }).pass).toBe(false);
    expect(gradeRun(rec, { kind: "tokens", maxTotal: 200 }).pass).toBe(true);
    expect(gradeRun(rec, { kind: "tokens", maxTotal: 100 }).pass).toBe(false);
  });

  it("scoreScenario 聚合多 grader 分数", () => {
    const graders: BenchGrader[] = [
      { kind: "status", expect: "completed" },
      { kind: "value", path: "sum", equals: 5050 },
    ];
    const result = scoreScenario("calc-sum-ts", [rec, rec], graders);
    expect(result.score).toBe(1);
    expect(result.grades).toHaveLength(4);
  });

  it("buildReport 汇总 passed/meanScore", () => {
    const result = scoreScenario("calc-sum-ts", [rec], [{ kind: "status", expect: "completed" }]);
    const report = buildReport("core", [result], 1000);
    expect(report.summary.total).toBe(1);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.meanScore).toBe(1);
  });
});
