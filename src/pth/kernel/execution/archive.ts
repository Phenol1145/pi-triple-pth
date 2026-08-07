import type { PgTranscriptStore } from "../storage/transcript-store.js";
import type { Task } from "../storage/task-store-pg.js";
import type { InterpreterResult } from "../interpreter/types.js";

export interface ArchiveDeps {
  transcriptStore: Pick<PgTranscriptStore, "create">;
  workspaceMgr: { archive(taskId: string, dir: string): Promise<{ artifactPath: string }> };
  emitCleanup?: (info: { artifactPath: string; taskId: string }) => void;
}

/**
 * 转录归档（裁决 16/17/18）：执行记录 → pg transcripts；产物 → artifacts 卷。
 * v1：转录 = program/result/summary（结构化 JSONB）；产物 = 整目录 rename（指针入 pg）。
 * 清理策略（裁决 17）：产物不自动清理——推清理提示到交互层。
 *
 * 错误边界（Task 2 ledger 遗留）：本函数不 catch 内部错误——产物归档/转录失败会向上抛，
 * 由 TaskLoop.execute 的 try/catch 兜底（转为 reject）。副作用：submit 成功后再抛错会
 * reject 已提交任务（ledger 遗留，见 Task 2 minor；TaskLoop 层重构时裁决）。
 */
export async function archiveTask(
  task: Task,
  ws: { dir: string },
  result: InterpreterResult,
  deps: ArchiveDeps,
): Promise<void> {
  const { artifactPath } = await deps.workspaceMgr.archive(task.id, ws.dir);
  await deps.transcriptStore.create({
    taskId: task.id,
    // claim 即承诺（裁决 10）：执行时 claimed_by 必已落库；?? "" 仅为类型兜底
    agentId: task.claimed_by ?? "",
    body: [
      { type: "program", program: task.text },
      result.ok
        ? { type: "result", result: result.value, stdout: result.stdout, stderr: result.stderr }
        : { type: "result", ok: false, error: result.error },
      { type: "summary", summary: summarize(result) },
    ],
    artifactPath,
  });
  // 清理提示（不自动删——裁决 17）
  deps.emitCleanup?.({ artifactPath, taskId: task.id });
}

/** v1 简单摘要：结果值 JSON 化前 200 字符 */
function summarize(result: InterpreterResult): string {
  if (!result.ok) return `failed: ${result.error?.message ?? "unknown error"}`;
  try {
    return JSON.stringify(result.value ?? result.stdout ?? "").slice(0, 200);
  } catch {
    return String(result.value ?? "").slice(0, 200);
  }
}
