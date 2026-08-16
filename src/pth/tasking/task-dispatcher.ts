/**
 * tasking/task-dispatcher.ts — 固定 claim → load → run → commit 序列（模块化 v2 P1-5）。
 *
 * - claim 空则零执行；
 * - runner 抛错 → 生成 terminal outcome（runner-crashed）并照常走一次 commit；
 * - commit 返回 committed:false → runner 结果不触发任何 observer；
 * - pause/stop 为 worker 级控制；stale lease（generation 非法）跳过且不执行。
 */

import {
  isTaskLeaseStructurallyValid,
  type TaskLease,
  type TaskOutcome,
  type TaskRepository,
  type TaskRunner,
  type TenantScope,
} from "../contracts/index.js";
import type { TaskOutcomeCommitter } from "./task-outcome-committer.js";

export type TaskOutcomeObserver = (event: { outcome: TaskOutcome; committed: boolean }) => void | Promise<void>;

export interface TaskDispatcherDeps {
  repository: TaskRepository;
  committer: TaskOutcomeCommitter;
  runner: TaskRunner;
  observers?: readonly TaskOutcomeObserver[];
  logger?: (msg: string) => void;
}

export interface DispatchResult {
  claimed: number;
  ran: number;
  committed: number;
  skipped: number;
}

export class TaskDispatcher {
  private paused = false;
  private stopped = false;

  constructor(private deps: TaskDispatcherDeps) {}

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  stop(): void { this.stopped = true; }
  get isPaused(): boolean { return this.paused; }
  get isStopped(): boolean { return this.stopped; }

  async dispatchOnce(scope: TenantScope, roleId: string, taskIds: readonly string[]): Promise<DispatchResult> {
    const result: DispatchResult = { claimed: 0, ran: 0, committed: 0, skipped: 0 };
    if (this.paused || this.stopped || taskIds.length === 0) return result;

    const claimed = await this.deps.repository.claim(scope, roleId, taskIds);
    result.claimed = claimed.length;
    if (claimed.length === 0) return result;

    for (const { lease, work } of claimed) {
      if (this.stopped) break;
      // stale/invalid lease 属于仓库数据异常：跳过，不执行、不提交、不触发 observer
      if (!isTaskLeaseStructurallyValid(lease)) {
        result.skipped++;
        continue;
      }

      let outcome: TaskOutcome;
      try {
        outcome = await this.deps.runner.run({ lease, work });
      } catch (e) {
        outcome = {
          lease: { taskId: lease.taskId, leaseId: lease.leaseId, generation: lease.generation },
          status: "rejected",
          retryable: false,
          error: { code: "runner-crashed", message: e instanceof Error ? e.message : String(e) },
          artifacts: [],
          traceId: work.scope.traceId,
        };
      }

      result.ran++;
      const { committed } = await this.deps.committer.commit(outcome);
      if (committed) result.committed++;

      if (committed) {
        for (const observer of this.deps.observers ?? []) {
          try {
            await observer({ outcome, committed });
          } catch (e) {
            this.deps.logger?.(`observer failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }

    return result;
  }
}
