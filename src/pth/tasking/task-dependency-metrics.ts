/**
 * tasking/task-dependency-metrics.ts —— 持久化子任务委派 V1 观测指标（M5）。
 *
 * 这些指标需要注册到主进程 /metrics 的同一个 Registry；
 * 生产入口在 main.ts 调用 `initTaskDependencyMetrics(metrics.registry)`。
 * 未初始化时所有 observe 方法为 no-op（测试/batch 子进程不暴露 /metrics）。
 */

import { Counter, Gauge, type Registry } from "prom-client";

export interface TaskDependencyMetrics {
  submission(parentRole: string, childRole: string, derived: boolean): void;
  dependencyStatus(status: string, count?: number): void;
  waitingDependencyAge(seconds: number): void;
  reconcileRepairs(count: number): void;
  submissionConflict(): void;
  admissionRejected(reason: string): void;
}

let impl: TaskDependencyMetrics | null = null;

export function initTaskDependencyMetrics(registry: Registry): TaskDependencyMetrics {
  const submissionsTotal = new Counter({
    name: "pth_task_submissions_total",
    help: "Persistent child task submissions created",
    labelNames: ["parent_role", "child_role", "derived"] as const,
    registers: [registry],
  });
  const dependencyStatusTotal = new Counter({
    name: "pth_task_dependency_status_total",
    help: "Task dependency terminal status transitions",
    labelNames: ["status"] as const,
    registers: [registry],
  });
  const waitingDependencyAge = new Gauge({
    name: "pth_task_waiting_dependency_age_seconds",
    help: "Age in seconds of the oldest task currently waiting on required dependencies",
    registers: [registry],
  });
  const reconcileRepairsTotal = new Counter({
    name: "pth_task_dependency_reconcile_repairs_total",
    help: "Dependency reconciliation repairs/requeues performed",
    registers: [registry],
  });
  const submissionConflictTotal = new Counter({
    name: "pth_task_submission_conflict_total",
    help: "submissionKey conflicts rejected by delegate()",
    registers: [registry],
  });
  const admissionRejectedTotal = new Counter({
    name: "pth_task_admission_rejected_total",
    help: "Persistent child delegation admissions rejected before write",
    labelNames: ["reason"] as const,
    registers: [registry],
  });

  impl = {
    submission(parentRole, childRole, derived) {
      submissionsTotal.inc({ parent_role: parentRole, child_role: childRole, derived: String(derived) });
    },
    dependencyStatus(status, count = 1) {
      if (count > 0) dependencyStatusTotal.inc({ status }, count);
    },
    waitingDependencyAge(seconds) {
      waitingDependencyAge.set(seconds);
    },
    reconcileRepairs(count) {
      if (count > 0) reconcileRepairsTotal.inc(count);
    },
    submissionConflict() {
      submissionConflictTotal.inc();
    },
    admissionRejected(reason) {
      admissionRejectedTotal.inc({ reason });
    },
  };
  return impl;
}

export function resetTaskDependencyMetrics(): void {
  impl = null;
}

export function observeTaskSubmission(parentRole: string, childRole: string, derived: boolean): void {
  impl?.submission(parentRole, childRole, derived);
}

export function observeDependencyStatus(status: string, count = 1): void {
  impl?.dependencyStatus(status, count);
}

export function observeWaitingDependencyAge(seconds: number): void {
  impl?.waitingDependencyAge(seconds);
}

export function observeReconcileRepairs(count: number): void {
  impl?.reconcileRepairs(count);
}

export function observeSubmissionConflict(): void {
  impl?.submissionConflict();
}

export function observeAdmissionRejected(reason: string): void {
  impl?.admissionRejected(reason);
}
