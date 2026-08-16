/**
 * tasking/task-outcome-committer.ts — outcome 提交器（模块化 v2 P1-5）。
 *
 * 固定 claim → run → commit 序列中的 commit 环节；直接委托 TaskRepository 的
 * CAS commit。observer 是否 fan-out 由 dispatcher 按 committed 决定。
 */

import type { TaskOutcome, TaskRepository } from "../contracts/index.js";

export interface TaskOutcomeCommitterPort {
  commit(outcome: TaskOutcome): Promise<{ committed: boolean }>;
}

export class TaskOutcomeCommitter implements TaskOutcomeCommitterPort {
  constructor(private repository: TaskRepository) {}

  commit(outcome: TaskOutcome): Promise<{ committed: boolean }> {
    return this.repository.commit(outcome);
  }
}
