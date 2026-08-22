/**
 * task-loop-helpers.ts —— 任务完成通知 + 原因分类（模块专项 ② 大文件拆分：自 task-loop.ts 抽出）。
 */
import { pthConfig } from "@away_from/pth-config";

/**
 * 任务完成通知（2026-08-13 hook 机制）：POST 到 PTL 侧 pth-notify 扩展
 * （http://host.docker.internal:PTH_NOTIFY_PORT/pth-events——主会话消息注入）。
 * fire-and-forget（超时 2s——不阻塞任务循环；通知失败仅告警）。
 */
export function notifyTaskDone(ev: { taskId: string; role: string; status: "completed" | "rejected"; summary?: string; error?: string }): void {
  const url = pthConfig().str("PTH_NOTIFY_URL");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...ev, ts: Date.now() }),
    signal: ctrl.signal,
  }).catch(() => { /* 通知不可达（PTL 未运行/扩展未装载）——静默 */ })
    .finally(() => clearTimeout(timer));
}


/** 拒绝原因前缀分类（SPEC L2：防 label 基数爆炸） */
export function classifyReason(reason: string): string {
  if (reason.startsWith("execution-failed")) return "execution-failed";
  if (reason.startsWith("execution-crashed")) return "execution-crashed";
  if (reason.startsWith("assessed-as-unfit")) return "assessed-unfit";
  if (reason.includes("timed out")) return "timeout";
  return "other";
}

