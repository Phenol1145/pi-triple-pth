#!/usr/bin/env tsx
/**
 * scripts/bench/pth-bench-run.ts —— PTH Bench CLI 薄壳（W1 后半）。
 *
 * 用法：
 *   PTH_API=http://localhost:3000 PTH_TOKEN=... npx tsx scripts/bench/pth-bench-run.ts
 */

import { HttpBenchDriver, runSuite, checkGate } from "../../src/pth/bench/index.js";
import type { BenchScenario } from "../../src/pth/bench/index.js";

const baseUrl = process.env.PTH_API ?? "http://localhost:3000";
const token = process.env.PTH_TOKEN ?? "";

const scenarios: BenchScenario[] = [
  {
    id: "calc-sum-ts",
    title: "用 ts 计算 1..100 的和",
    tags: ["code"],
    execPolicy: { repeats: 1, warmup: 0, concurrency: 1, timeoutMs: 60_000 },
    graders: [
      { kind: "status", expect: "completed" },
      { kind: "value", path: "sum", equals: 5050 },
    ],
  },
];

async function main(): Promise<void> {
  if (!token) {
    console.error("PTH_TOKEN 未设置");
    process.exit(2);
  }
  const driver = new HttpBenchDriver({ baseUrl, token });
  const report = await runSuite(driver, "core", scenarios);
  const gate = checkGate(report, { scoreFloor: 1 });
  console.log(JSON.stringify({ suite: report.suite, summary: report.summary, exitCode: gate.exitCode }, null, 2));
  process.exit(gate.exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
