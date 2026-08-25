import { describe, it, expect, afterEach } from "vitest";
import { Registry } from "prom-client";
import {
  initTaskDependencyMetrics,
  observeTaskSubmission,
  observeDependencyStatus,
  observeWaitingDependencyAge,
  observeReconcileRepairs,
  observeSubmissionConflict,
  observeAdmissionRejected,
  resetTaskDependencyMetrics,
} from "../../src/pth/tasking/task-dependency-metrics.js";

describe("task dependency metrics（M5）", () => {
  afterEach(() => {
    resetTaskDependencyMetrics();
  });

  it("init 后注册 M5 指标，observe 能写入计数/标尺", async () => {
    const registry = new Registry();
    initTaskDependencyMetrics(registry);

    observeTaskSubmission("developer", "coder", true);
    observeTaskSubmission("developer", "coder", false);
    observeDependencyStatus("satisfied", 2);
    observeWaitingDependencyAge(42);
    observeReconcileRepairs(3);
    observeSubmissionConflict();
    observeAdmissionRejected("child-limit");

    const json = await registry.getMetricsAsJSON();
    const metricNames = new Set(json.map((m) => m.name));
    for (const name of [
      "pth_task_submissions_total",
      "pth_task_dependency_status_total",
      "pth_task_waiting_dependency_age_seconds",
      "pth_task_dependency_reconcile_repairs_total",
      "pth_task_submission_conflict_total",
      "pth_task_admission_rejected_total",
    ]) {
      expect(metricNames.has(name)).toBe(true);
    }

    const submissions = json.find((m) => m.name === "pth_task_submissions_total");
    const values = submissions?.values ?? [];
    const derivedTrue = values.find((v) => v.labels?.derived === "true" && v.labels?.parent_role === "developer" && v.labels?.child_role === "coder");
    const derivedFalse = values.find((v) => v.labels?.derived === "false" && v.labels?.parent_role === "developer" && v.labels?.child_role === "coder");
    expect(derivedTrue?.value).toBe(1);
    expect(derivedFalse?.value).toBe(1);

    const deps = json.find((m) => m.name === "pth_task_dependency_status_total");
    expect(deps?.values.find((v) => v.labels?.status === "satisfied")?.value).toBe(2);

    const age = json.find((m) => m.name === "pth_task_waiting_dependency_age_seconds");
    expect(age?.values[0]?.value).toBe(42);

    const repairs = json.find((m) => m.name === "pth_task_dependency_reconcile_repairs_total");
    expect(repairs?.values[0]?.value).toBe(3);

    const conflicts = json.find((m) => m.name === "pth_task_submission_conflict_total");
    expect(conflicts?.values[0]?.value).toBe(1);

    const admission = json.find((m) => m.name === "pth_task_admission_rejected_total");
    expect(admission?.values.find((v) => v.labels?.reason === "child-limit")?.value).toBe(1);
  });

  it("未 init 时 observe 为 no-op（不抛错）", () => {
    resetTaskDependencyMetrics();
    expect(() => {
      observeTaskSubmission("developer", "coder", true);
      observeDependencyStatus("satisfied");
      observeWaitingDependencyAge(1);
      observeReconcileRepairs(1);
      observeSubmissionConflict();
      observeAdmissionRejected("child-limit");
    }).not.toThrow();
  });
});
