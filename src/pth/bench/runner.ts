/**
 * pth/bench/runner.ts —— PTH Bench W1：统一 runner。
 *
 * Runner 只面向 BenchDriver 端口；repeats/warmup 由 ExecPolicy 驱动，
 * 场景分 = 所有重复 × 所有 grader 的分数均值。
 */

import {
  scoreScenario,
  buildReport,
  type BenchScenario,
  type BenchRunRecord,
  type BenchScenarioResult,
  type BenchReport,
  type BenchExecPolicy,
} from "./core.js";

export interface BenchDriver {
  execute(scenario: BenchScenario, repeat: number, policy: BenchExecPolicy): Promise<BenchRunRecord>;
}

export const DEFAULT_BENCH_POLICY: BenchExecPolicy = {
  repeats: 1,
  warmup: 0,
  concurrency: 1,
  timeoutMs: 180_000,
};

export function resolvePolicy(scenario: BenchScenario, overrides?: Partial<BenchExecPolicy>): BenchExecPolicy {
  return {
    ...DEFAULT_BENCH_POLICY,
    ...(scenario.execPolicy ?? {}),
    ...(overrides ?? {}),
  };
}

export async function runScenario(
  driver: BenchDriver,
  scenario: BenchScenario,
  overrides?: Partial<BenchExecPolicy>,
): Promise<BenchScenarioResult> {
  const policy = resolvePolicy(scenario, overrides);
  const runs: BenchRunRecord[] = [];
  for (let i = 0; i < policy.warmup; i++) {
    await driver.execute(scenario, -i - 1, policy); // warmup 不计入结果
  }
  for (let i = 0; i < policy.repeats; i++) {
    runs.push(await driver.execute(scenario, i, policy));
  }
  return scoreScenario(scenario.id, runs, scenario.graders);
}

export async function runSuite(
  driver: BenchDriver,
  suite: string,
  scenarios: BenchScenario[],
  overrides?: Partial<BenchExecPolicy>,
): Promise<BenchReport> {
  const started = Date.now();
  const results: BenchScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(driver, scenario, overrides));
  }
  return buildReport(suite, results, Date.now() - started);
}
