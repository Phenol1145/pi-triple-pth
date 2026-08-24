/**
 * pth/bench/gate.ts —— PTH Bench W2：Baseline Gate（退出码三值）。
 *
 * 0 = 全过；1 = 门禁失败；2 = 设施故障（infra-error / 连不上栈等）。
 */

import type { BenchReport } from "./core.js";

export interface BenchGate {
  scoreFloor?: number;
  latencyRegressionPct?: number;
  tokenRegressionPct?: number;
  requireDeterministic?: boolean;
  perScenario?: Record<string, { maxExecMs?: number; maxTotalTokens?: number }>;
}

export interface GateResult {
  exitCode: 0 | 1 | 2;
  failures: string[];
}

export function checkGate(report: BenchReport, gate: BenchGate): GateResult {
  const failures: string[] = [];

  // 设施故障优先（2）：任何 run 为 infra-error / timeout 风暴视为环境问题。
  const infra = report.results.some((r) => r.runs.some((run) => run.status === "infra-error"));
  if (infra) return { exitCode: 2, failures: ["infra-error: 存在设施故障运行"] };

  if (gate.scoreFloor !== undefined && report.summary.meanScore < gate.scoreFloor) {
    failures.push(`meanScore=${report.summary.meanScore.toFixed(3)} < ${gate.scoreFloor}`);
  }

  for (const result of report.results) {
    const per = gate.perScenario?.[result.scenarioId];
    if (!per) continue;
    for (const run of result.runs) {
      if (per.maxExecMs !== undefined && (run.timing.execMs ?? run.timing.totalMs) > per.maxExecMs) {
        failures.push(`${result.scenarioId}: execMs=${run.timing.execMs ?? run.timing.totalMs} > ${per.maxExecMs}`);
      }
      const totalTokens = (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0);
      if (per.maxTotalTokens !== undefined && totalTokens > per.maxTotalTokens) {
        failures.push(`${result.scenarioId}: tokens=${totalTokens} > ${per.maxTotalTokens}`);
      }
    }
  }

  return { exitCode: failures.length > 0 ? 1 : 0, failures };
}
