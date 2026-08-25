/**
 * tasking/task-dependency-reconciler.ts —— 持久化子任务委派 V1 的最终收敛器（M2）。
 *
 * 事件只做低延迟提示；进程重启/事件丢失时，本服务依据 PG 真相源收敛：
 *  1. 修复孤儿 dependency：child 已终态但 dependency 仍 pending → 按 child 终态补写 envelope；
 *  2. requeue 所有已无 pending dependency 的 waiting_dependency 父任务。
 *
 * 装配在 main 进程，与 TaskDispatchNotifier 并列启动/停止。
 */

import type pg from "pg";
import { pthConfig } from "@away_from/pth-config";
import { applyChildTerminalToParent } from "./task-dispatch-notifier.js";
import { observeReconcileRepairs, observeWaitingDependencyAge } from "./task-dependency-metrics.js";

export interface TaskDependencyReconcilerDeps {
  pool: pg.Pool;
  logger?: (msg: string) => void;
  intervalMs?: number;
}

export class TaskDependencyReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private running = false;

  constructor(private deps: TaskDependencyReconcilerDeps) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = this.deps.intervalMs ?? pthConfig().num("PTH_TASK_DEPENDENCY_RECONCILE_MS");
    this.timer = setInterval(() => {
      void this.reconcile().catch((err: Error) => {
        this.deps.logger?.(`[task-dependency-reconciler] 收敛失败: ${err.message}`);
      });
    }, intervalMs);
    this.timer.unref?.();
    // 启动后立即跑一轮，缩短事件丢失窗口。
    void this.reconcile().catch((err: Error) => {
      this.deps.logger?.(`[task-dependency-reconciler] 启动收敛失败: ${err.message}`);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get isStopped(): boolean { return this.stopped; }

  /** 执行一轮收敛；返回修复/唤醒的任务数。已有运行中的轮次时跳过（防 setInterval 重叠）。 */
  async reconcile(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let repaired = 0;

      // 1. 孤儿 child 终态 → 补写 dependency（复用 notifier 的幂等 apply 函数）。
      const orphans = await this.deps.pool.query(
        `SELECT d.child_task_id
         FROM task_dependencies d
         JOIN tasks t ON t.id = d.child_task_id AND t.tenant_id = d.tenant_id
         WHERE d.status = 'pending'
           AND t.status IN ('completed','rejected','escalated')`,
      );
      for (const row of orphans.rows as Array<{ child_task_id: string }>) {
        const did = await applyChildTerminalToParent(this.deps.pool, row.child_task_id, this.deps.logger);
        if (did) repaired++;
      }

      // 2. 已无 pending dependency 的 waiting_dependency 父任务 → requeue。
      const waitingParents = await this.deps.pool.query(
        `SELECT DISTINCT p.id, p.tenant_id
         FROM tasks p
         WHERE p.status = 'waiting_dependency'
           AND NOT EXISTS (
             SELECT 1 FROM task_dependencies d
             WHERE d.tenant_id = p.tenant_id AND d.parent_task_id = p.id AND d.status = 'pending'
           )`,
      );
      for (const row of waitingParents.rows as Array<{ id: string; tenant_id: string }>) {
        const upd = await this.deps.pool.query(
          `UPDATE tasks SET
             status = 'pending',
             waiting_dependency_at = NULL,
             updated_at = now()
           WHERE id = $1 AND tenant_id = $2 AND status = 'waiting_dependency'`,
          [row.id, row.tenant_id],
        );
        if ((upd.rowCount ?? 0) > 0) repaired++;
      }

      // 3. 观测：当前最老 waiting_dependency 任务年龄（秒）——以进入状态时间为准。
      const ageRes = await this.deps.pool.query(
        `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(COALESCE(waiting_dependency_at, created_at))))::int, 0) AS age_seconds
         FROM tasks WHERE status = 'waiting_dependency'`,
      );
      observeWaitingDependencyAge(Number((ageRes.rows[0] as { age_seconds?: string | number } | undefined)?.age_seconds ?? 0));

      observeReconcileRepairs(repaired);
      if (repaired > 0) this.deps.logger?.(`[task-dependency-reconciler] 收敛修复/唤醒 ${repaired} 个任务`);
      return repaired;
    } finally {
      this.running = false;
    }
  }
}
