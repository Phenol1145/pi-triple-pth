/**
 * tasking/task-dispatcher.ts — 固定 claim → load → run → commit 序列（模块化 v2 P1-5 / R4）。
 *
 * - claim 空则零执行；
 * - runner 抛错 → 生成 terminal outcome（runner-crashed）并照常走一次 commit；
 * - R4/P0-4：commit 前调用 buildSideEffects 生成同事务 side-effect enqueue；
 * - commit 返回 committed:false → runner 结果不触发任何 observer；
 * - pause/stop 为 worker 级控制；stale lease（generation 非法）跳过且不执行。
 */

import {
  isTaskLeaseStructurallyValid,
  isTaskSuspensionStructurallyValid,
  type TaskCommitOptions,
  type TaskLease,
  type TaskOutcome,
  type TaskRepository,
  type TaskRunner,
  type TaskSuspension,
  type TaskWorkItem,
  type TenantScope,
} from "@away_from/pth-contracts";
import type { TaskOutcomeCommitter, TaskOutcomeSideEffect } from "./task-outcome-committer.js";
import {
  notifyObservers,
  type ObserverFailureRecord,
  type TaskOutcomeObserver,
  type TaskOutcomeObserverEvent,
} from "./task-outcome-observers.js";

export interface TaskDispatcherDeps {
  repository: TaskRepository;
  committer: TaskOutcomeCommitter;
  runner: TaskRunner;
  observers?: readonly TaskOutcomeObserver[];
  /** durable observer failure 记录器（如写入 side_effect_outbox kind=observer-failure）。 */
  onObserverFailure?: (failure: ObserverFailureRecord) => void | Promise<void>;
  /** 同事务 side-effect enqueue 的生成器（如 refine payload）；在 commit 前调用。 */
  buildSideEffects?: (
    event: TaskOutcomeObserverEvent,
  ) => Promise<ReadonlyArray<TaskOutcomeSideEffect>> | ReadonlyArray<TaskOutcomeSideEffect>;
  /** observer 事件的附加上下文（task/workspace/trace 等——runner 不感知，调用方装配） */
  context?: Record<string, unknown>;
  logger?: (msg: string) => void;
  /** TaskSuspension 处理钩子（装配层注入；缺省仅跳过，不 commit） */
  onSuspension?: (input: { lease: TaskLease; work: TaskWorkItem; suspension: TaskSuspension }) => void | Promise<void>;
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

      let runResult: TaskOutcome | TaskSuspension;
      // W2：执行期租约心跳续约（CAS——lease_id+generation+status；失败=lease 已被回收→abort runner 防双写）
      const runAbort = new AbortController();
      const remainingMs = Math.max(60_000, new Date(lease.deadlineAt).getTime() - Date.now());
      const heartbeatMs = Math.max(1_000, Math.floor(remainingMs / 3));
      const heartbeat = setInterval(() => {
        this.deps.repository.renewLease({ taskId: lease.taskId, leaseId: lease.leaseId, generation: lease.generation })
          .then(({ renewed }) => {
            if (!renewed) {
              this.deps.logger?.(`[lease] renew failed task=${lease.taskId}（lease lost——abort runner）`);
              runAbort.abort();
            }
          })
          .catch((e) => {
            this.deps.logger?.(`[lease] renew error task=${lease.taskId}: ${(e as Error).message}`);
          });
      }, heartbeatMs);
      heartbeat.unref?.();
      try {
        runResult = await this.deps.runner.run({ lease, work, signal: runAbort.signal });
      } catch (e) {
        runResult = {
          lease: { taskId: lease.taskId, leaseId: lease.leaseId, generation: lease.generation },
          status: "rejected",
          retryable: false,
          error: { code: "runner-crashed", message: e instanceof Error ? e.message : String(e) },
          artifacts: [],
          traceId: work.scope.traceId,
        };
      } finally {
        clearInterval(heartbeat);
      }

      // TaskSuspension：不 commit、不触发 observer；由装配层 onSuspension 决定持久化/释放。
      if (isTaskSuspensionStructurallyValid(runResult)) {
        result.skipped++;
        await this.deps.onSuspension?.({ lease, work, suspension: runResult });
        continue;
      }
      const outcome = runResult;

      result.ran++;
      const event: TaskOutcomeObserverEvent = {
        outcome,
        committed: true,
        lease,
        work,
        context: this.deps.context,
      };
      const sideEffects = await this.deps.buildSideEffects?.(event) ?? [];
      // N29 P0-2：tenant scope 由服务端 claim 时签发的 lease 盖章（不取 worker outcome body）；
      // 仓库据此把 tenant_id AND 进 CAS 谓词——错 tenant 只会 committed=false。
      const commitOpts: TaskCommitOptions = { sideEffects, scope: { tenantId: lease.scope.tenantId } };
      const { committed } = await this.deps.committer.commit(outcome, commitOpts);
      if (committed) result.committed++;

      if (committed) {
        await notifyObservers(this.deps.observers ?? [], event, {
          logger: this.deps.logger,
          recordFailure: this.deps.onObserverFailure,
        });
      }
    }

    return result;
  }
}
