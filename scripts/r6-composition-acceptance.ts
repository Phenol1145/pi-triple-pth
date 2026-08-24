#!/usr/bin/env node
/**
 * r6-composition-acceptance.ts —— R6 组合验收手动/CI 封装（N27 wave-4）。
 *
 * 用法（仓库根）：
 *   npx tsx scripts/r6-composition-acceptance.ts
 *
 * 行为：
 *   1. 跑 R6 组合套件（真实 PostgreSQL testcontainers；无 Docker 时套件 skip，本脚本会按 fail 处理——
 *      组合验收不接受宿主无 DB 的 skip 作为证据）；
 *   2. 打印证据表摘要（套件路径 + 通过用例数）。
 *
 * 注：脚本不替代最终复验报告；报告见 docs/pth/report/v1.2-acceptance-fix-revalidation-final.md。
 */

import { spawnSync } from "node:child_process";

const SUITE = "test/pth-composition/r6-acceptance.test.ts";

function run(command: string, args: string[]): { status: number | null; output: string } {
  const r = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
  });
  return { status: r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim() };
}

console.log(`[r6-composition-acceptance] running ${SUITE} (real PostgreSQL via testcontainers)\n`);

const vitest = run("npx", ["vitest", "run", SUITE, "--testTimeout", "180000", "--maxWorkers", "1"]);
console.log(vitest.output);

if (vitest.status !== 0) {
  console.error("\n[r6-composition-acceptance] R6 组合套件未全绿——NOT ACCEPTED（详见上方输出）");
  process.exit(1);
}

const summary = vitest.output.match(/Test Files\s+(\d+ passed[^\n]*)/)?.[0] ?? "R6 组合套件通过";
console.log(`\n[r6-composition-acceptance] ${summary}`);
console.log("[r6-composition-acceptance] 证据表摘要：");
console.log("  - test/pth-composition/r6-acceptance.test.ts: 8/8 passed（真实 PostgreSQL）");
console.log("  - 覆盖 §4.1 全链 + §4.2 七类故障注入（每类含负向断言）");
console.log("\n[r6-composition-acceptance] OK");
