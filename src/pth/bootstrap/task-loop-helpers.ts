/**
 * task-loop-helpers.ts —— 任务完成通知 + 原因分类（模块专项 ② 大文件拆分：自 task-loop.ts 抽出）。
 *
 * notifyTaskDone canonical 在 runner/observers/notifier-observer.ts；这里 re-export
 * 保住 legacy task-loop 的既有 import 与行为。
 */
export { notifyTaskDone } from "../runner/observers/notifier-observer.js";


/** 拒绝原因前缀分类（SPEC L2：防 label 基数爆炸） */
export function classifyReason(reason: string): string {
  if (reason.startsWith("execution-failed")) return "execution-failed";
  if (reason.startsWith("execution-crashed")) return "execution-crashed";
  if (reason.startsWith("assessed-as-unfit")) return "assessed-unfit";
  if (reason.includes("timed out")) return "timeout";
  return "other";
}

