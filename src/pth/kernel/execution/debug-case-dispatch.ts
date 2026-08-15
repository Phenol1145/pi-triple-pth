/**
 * debug-case-dispatch.ts —— 调试用例 writer 派发（P3.6——自修正闭环的验证环节）。
 *
 * 触发（2026-08-15 计划）：
 *   ① developer 修复任务完成后自动派发（task-loop 完成点调用）；
 *   ② controller 裁决批准修复后经 manage.fix.approve 派发（治理面通道）。
 * 产物契约（debug-case-writer done.result）：{ repro, regression, boundary, verification }——
 *   验收标准：用例能在修复前复现 bug（FAIL），修复后回归通过（PASS）。
 */

import type { Task, TaskStore } from "../storage/task-store-pg.js";

export interface DebugCaseDispatchInput {
  /** bug 报告/任务原文（自包含） */
  bugReport: string;
  /** 修复产物摘要（diff/实现说明——debug-case-writer 的输入） */
  fixSummary?: string;
  /** 上游任务（审计/追溯） */
  parentTaskId?: string;
  /** 触发来源：developer-fix-completed | controller-fix-approved */
  source: string;
}

const MAX_TEXT = 24_000;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…（截断 ${s.length - max} 字符）`;
}

/** 自包含任务文本（debug-case-writer 不依赖上下文即可开工） */
export function buildDebugCaseTaskText(input: DebugCaseDispatchInput): string {
  return `【调试用例任务——自修正闭环验证环节】

上游已批准/完成一项修复。请为该缺陷产出三类用例并实际验证：

1. 最小复现用例：触发 bug 的条件序列——修复前应 FAIL（写出失败证据或说明如何在修复前复现）。
2. 回归测试：vitest 用例——修复后应 PASS（防复发——测试文件写任务工作区并用 bash 实际跑通）。
3. 边界用例：相关边界的探索（空值/极值/类型边界/并发/组合输入——至少 3 条）。

## bug 报告 / 原任务
${clip(input.bugReport, 12_000)}

${input.fixSummary ? `## 修复产物摘要\n${clip(input.fixSummary, 10_000)}\n` : "## 修复产物摘要\n（未提供——可从 bug 报告与代码库现状自行调查）"}

## 产物契约（done.result 必遵）
{
  "repro": "<最小复现用例（代码/命令/条件序列）>",
  "regression": "<回归测试文件路径 + 关键断言>",
  "boundary": ["边界用例1", "边界用例2", "边界用例3"],
  "verification": { "beforeFix": "<修复前 FAIL 证据>", "afterFix": "<修复后 PASS 证据>", "commands": ["实际跑过的命令"] }
}

验收标准：repro/regression/boundary/verification 四项齐全；verification 含真实运行输出（不基于假设报成功）；regression 文件写任务工作区可查。`;
}

/** 发布 debug-case 任务（tags 路由到 debug-case-writer——角色标签自动注册） */
export async function publishDebugCaseTask(
  taskStore: TaskStore,
  input: DebugCaseDispatchInput,
): Promise<Task> {
  const text = buildDebugCaseTaskText(input);
  const title = `【debug-case】${clip(input.bugReport.split("\n")[0] ?? "bug", 60)}`;
  return taskStore.publish({
    title,
    text,
    createdBy: "debug-case-dispatch",
    tags: ["debug-case"],
    payload: {
      source: input.source,
      parentTaskId: input.parentTaskId,
      debugCases: "on",
    },
  });
}
