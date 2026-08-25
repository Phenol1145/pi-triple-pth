import { describe, it, expect } from "vitest";
import { checkGate, type BenchGate } from "../../src/pth/bench/gate.js";
import { buildReport, scoreScenario, type BenchRunRecord } from "../../src/pth/bench/core.js";

function reportWith(rec: BenchRunRecord) {
  const result = scoreScenario("s1", [rec], [{ kind: "status", expect: "completed" }]);
  return buildReport("core", [result], 100);
}

describe("PTH Bench W2 gate", () => {
  it("全过 → exit 0", () => {
    const gate: BenchGate = { scoreFloor: 0.9 };
    const r = reportWith({ scenarioId: "s1", repeat: 0, startedAt: "", status: "completed", timing: { totalMs: 10 }, value: {} });
    expect(checkGate(r, gate).exitCode).toBe(0);
  });

  it("分数不达标 → exit 1", () => {
    const gate: BenchGate = { scoreFloor: 0.99 };
    const rec: BenchRunRecord = { scenarioId: "s1", repeat: 0, startedAt: "", status: "rejected", timing: { totalMs: 10 }, value: {} };
    const r = reportWith(rec);
    const result = checkGate(r, gate);
    expect(result.exitCode).toBe(1);
    expect(result.failures.join(" ")).toContain("meanScore");
  });

  it("infra-error → exit 2", () => {
    const gate: BenchGate = {};
    const rec: BenchRunRecord = { scenarioId: "s1", repeat: 0, startedAt: "", status: "infra-error", timing: { totalMs: 10 } };
    const r = reportWith(rec);
    expect(checkGate(r, gate).exitCode).toBe(2);
  });
});
