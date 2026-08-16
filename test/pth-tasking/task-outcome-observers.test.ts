import { describe, expect, it, vi } from "vitest";
import {
  BoundedBackgroundQueue,
  notifyObservers,
  type TaskOutcomeObserver,
} from "../../src/pth/tasking/task-outcome-observers.js";
import { createAuditObserver } from "../../src/pth/runner/observers/audit-observer.js";
import { createTranscriptObserver } from "../../src/pth/runner/observers/transcript-observer.js";
import { createActivityObserver } from "../../src/pth/runner/observers/activity-observer.js";
import { createMetricsObserver } from "../../src/pth/runner/observers/metrics-observer.js";
import type { TaskLease, TaskOutcome, TaskWorkItem } from "../../src/pth/contracts/index.js";

function lease(): TaskLease {
  return {
    taskId: "task-1",
    leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6",
    generation: 1,
    scope: { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-1" },
    roleId: "developer",
    workspace: { tenantId: "tenant-a", workspaceId: "task:task-1", taskId: "task-1" },
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function work(): TaskWorkItem {
  return {
    taskId: "task-1",
    scope: { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-1" },
    title: "t", text: "x", tags: [], payload: {}, assignedRole: "developer",
  };
}

function event(overrides: Partial<TaskOutcome> = {}): Parameters<TaskOutcomeObserver>[0] {
  return {
    lease: lease(),
    work: work(),
    committed: true,
    outcome: {
      lease: { taskId: "task-1", leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6", generation: 1 },
      status: "completed",
      result: { ok: true },
      artifacts: [],
      traceId: "trace-1",
      ...overrides,
    },
    context: { traceEvents: [{ type: "llm-call", step: 0, contentPreview: "x" }], chain: { chainDepth: 0 }, execMs: 10, task: { id: "task-1", payload: {} } },
  };
}

describe("task outcome observers（P1-7）", () => {
  it("notifyObservers：单个 observer 抛错不影响其他 observer", async () => {
    const calls: string[] = [];
    const observers: TaskOutcomeObserver[] = [
      async () => { calls.push("a"); throw new Error("boom"); },
      async () => { calls.push("b"); },
    ];
    await notifyObservers(observers, event());
    expect(calls).toEqual(["a", "b"]);
  });

  it("BoundedBackgroundQueue：并发上限内执行，满则丢弃不阻塞", async () => {
    let released = 0;
    const queue = new BoundedBackgroundQueue({ maxConcurrency: 1 });
    const never = new Promise<void>(() => {});
    queue.enqueue(() => never);
    queue.enqueue(async () => { released++; });
    expect(released).toBe(0); // 第二个被丢——慢任务不占下一轮 claim
  });

  it("audit observer：committed 后写审计且带 tenantId", async () => {
    const writes: unknown[] = [];
    const observer = createAuditObserver({ write: async (ev) => { writes.push(ev); } });
    await observer(event());
    expect(writes[0]).toMatchObject({ eventType: "task_completed", tenantId: "tenant-a", taskId: "task-1" });
  });

  it("transcript observer：只写 trace 且带 tenantId", async () => {
    const creates: unknown[] = [];
    const observer = createTranscriptObserver({ create: async (input) => { creates.push(input); } });
    await observer(event());
    expect(creates[0]).toMatchObject({ taskId: "task-1", tenantId: "tenant-a", body: [{ type: "llm-call" }] });

    await observer(event({ result: undefined })); // rejected 时 result undefined
    expect(creates).toHaveLength(2);
  });

  it("activity/metrics observer：rejected 映射正确", async () => {
    const activities: unknown[] = [];
    const metrics: unknown[] = [];
    await createActivityObserver({ emit: (e) => activities.push(e) })(event({ status: "rejected", retryable: false, error: { code: "x", message: "bad" } }));
    await createMetricsObserver({ metric: (m) => metrics.push(m), classifyReason: (r) => (r.includes("bad") ? "other" : "other") })(event({ status: "rejected", retryable: false, error: { code: "x", message: "bad" } }));
    expect(activities[0]).toMatchObject({ kind: "task.rejected", ok: false });
    expect(metrics.some((m) => (m as { type: string }).type === "reject-reason")).toBe(true);
  });
});
