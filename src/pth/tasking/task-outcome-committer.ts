/**
 * tasking/task-outcome-committer.ts — outcome 提交器（模块化 v2 P1-5 / R4 / N29 L1）。
 *
 * 固定 claim → run → commit 序列中的 commit 环节。R4/P0-4 起，commit 可携带
 * 同事务 side-effect enqueue：committer 委托 TaskRepository 在同一 PG 事务内完成
 * task CAS commit + side_effect_outbox INSERT；enqueue 失败整体回滚。
 *
 * N29/P0-2：commit 选项额外携带服务端盖章的 tenant scope（contracts `TaskCommitScope`）——
 * 由 dispatcher 从 claim 返回的 lease 取值，worker outcome body 不是事实源；
 * side effect 的类型契约同步上移到 contracts（identity=(tenantId,key)）。
 */

import type { TaskCommitOptions, TaskCommitSideEffect, TaskOutcome, TaskRepository } from "@away_from/pth-contracts";

/** side effect 契约已上移 contracts（`TaskCommitSideEffect`）；保留别名供既有装配点引用。 */
export type TaskOutcomeSideEffect = TaskCommitSideEffect;
/** commit 选项契约已上移 contracts（`TaskCommitOptions`，含服务端 tenant scope）。 */
export type TaskOutcomeCommitOptions = TaskCommitOptions;

export interface TaskOutcomeCommitterPort {
  commit(outcome: TaskOutcome, opts?: TaskCommitOptions): Promise<{ committed: boolean }>;
}

export class TaskOutcomeCommitter implements TaskOutcomeCommitterPort {
  constructor(private repository: TaskRepository) {}

  commit(outcome: TaskOutcome, opts?: TaskCommitOptions): Promise<{ committed: boolean }> {
    return this.repository.commit(outcome, opts);
  }
}
