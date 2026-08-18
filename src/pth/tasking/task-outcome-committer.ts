/**
 * tasking/task-outcome-committer.ts — outcome 提交器（模块化 v2 P1-5 / R4）。
 *
 * 固定 claim → run → commit 序列中的 commit 环节。R4/P0-4 起，commit 可携带
 * 同事务 side-effect enqueue：committer 委托 TaskRepository 在同一 PG 事务内完成
 * task CAS commit + side_effect_outbox INSERT；enqueue 失败整体回滚。
 */

import type { TaskOutcome, TaskRepository } from "../contracts/index.js";

export interface TaskOutcomeSideEffect {
  key: string;
  tenantId: string;
  kind: string;
  payload: unknown;
}

export interface TaskOutcomeCommitOptions {
  sideEffects?: ReadonlyArray<TaskOutcomeSideEffect>;
}

export interface TaskOutcomeCommitterPort {
  commit(outcome: TaskOutcome, opts?: TaskOutcomeCommitOptions): Promise<{ committed: boolean }>;
}

type TaskRepositoryWithSideEffects = TaskRepository & {
  commit(outcome: TaskOutcome, opts?: TaskOutcomeCommitOptions): Promise<{ committed: boolean }>;
};

export class TaskOutcomeCommitter implements TaskOutcomeCommitterPort {
  constructor(private repository: TaskRepository) {}

  commit(outcome: TaskOutcome, opts?: TaskOutcomeCommitOptions): Promise<{ committed: boolean }> {
    return (this.repository as TaskRepositoryWithSideEffects).commit(outcome, opts);
  }
}
