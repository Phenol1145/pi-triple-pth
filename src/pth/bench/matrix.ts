/**
 * pth/bench/matrix.ts —— PTH Bench W4：matrix 展开（可裁项）。
 *
 * suite 级 execMode 矩阵 → 场景×模式笛卡尔积。
 */

import type { BenchScenario, BenchExecPolicy } from "./core.js";

export function expandMatrix(
  scenarios: BenchScenario[],
  execModes: Array<NonNullable<BenchExecPolicy["execMode"]>>,
): BenchScenario[] {
  return scenarios.flatMap((s) =>
    execModes.map((mode) => ({
      ...s,
      id: `${s.id}::${mode}`,
      execPolicy: { ...(s.execPolicy ?? {}), execMode: mode },
    })),
  );
}
