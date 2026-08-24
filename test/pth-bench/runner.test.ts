import { describe, it, expect } from "vitest";
import { runScenario, runSuite, type BenchDriver } from "../../src/pth/bench/runner.js";
import type { BenchScenario } from "../../src/pth/bench/core.js";

function fakeDriver(records: Array<{ value?: unknown; status?: string }>): BenchDriver {
  let i = 0;
  return {
    async execute(scenario, repeat) {
      const r = records[Math.min(i++, records.length - 1)]!;
      return {
        scenarioId: scenario.id,
        repeat,
        startedAt: new Date().toISOString(),
        status: r.status ?? "completed",
        timing: { totalMs: 100 + i * 10, execMs: 80 + i * 10 },
        value: r.value,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

describe("PTH Bench W1 runner", () => {
  const scenario: BenchScenario = {
    id: "calc-sum-ts",
    title: "求和",
    execPolicy: { repeats: 3 },
    graders: [
      { kind: "status", expect: "completed" },
      { kind: "value", path: "sum", equals: 5050 },
    ],
  };

  it("runScenario 按 repeats 执行并聚合", async () => {
    const driver = fakeDriver([{ value: { sum: 5050 } }, { value: { sum: 5050 } }, { value: { sum: 5050 } }]);
    const result = await runScenario(driver, scenario);
    expect(result.runs).toHaveLength(3);
    expect(result.score).toBe(1);
  });

  it("runSuite 汇总报告", async () => {
    const driver = fakeDriver([{ value: { sum: 5050 } }]);
    const report = await runSuite(driver, "core", [scenario], { repeats: 1 });
    expect(report.summary.total).toBe(1);
    expect(report.summary.passed).toBe(1);
  });
});
