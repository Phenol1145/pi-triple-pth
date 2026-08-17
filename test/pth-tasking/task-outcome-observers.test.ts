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
import { createRefineObserver } from "../../src/pth/runner/observers/refine-observer.js";
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
    title: "t", text: "x", tags: [], payload: {}, assignedRole: "developer", domains: [],
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

  it("refine observer：completed 同步 await enqueue（幂等 key + lineage payload）", async () => {
    const enqueues: Array<{ key: string; kind: string; payload: Record<string, unknown> }> = [];
    const observer = createRefineObserver({
      enqueue: async (key, kind, payload) => { enqueues.push({ key, kind, payload: payload as Record<string, unknown> }); },
      kernel: { snapshot: async () => ({ variables: [], functions: [], oversized: [] }) },
      roleId: "developer",
    });
    await observer(event());
    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]!.key).toBe("refine:tenant-a:task-1:1");
    expect(enqueues[0]!.kind).toBe("refine");
    expect(enqueues[0]!.payload).toMatchObject({
      taskId: "task-1",
      roleId: "developer",
      tenantId: "tenant-a",
      domains: [],
      outcome: { status: "completed", result: { ok: true } },
      artifactRefs: [],
    });
    expect(enqueues[0]!.payload.snapshot).toBeDefined();
  });

  it("refine observer：traceEvents 截断 60 条", async () => {
    const enqueues: Array<{ payload: Record<string, unknown> }> = [];
    const observer = createRefineObserver({
      enqueue: async (_key, _kind, payload) => { enqueues.push({ payload: payload as Record<string, unknown> }); },
      kernel: { snapshot: async () => ({ variables: [], functions: [], oversized: [] }) },
      roleId: "developer",
    });
    const ev = event() as unknown as Parameters<TaskOutcomeObserver>[0];
    ev.context = { ...ev.context, traceEvents: Array.from({ length: 65 }, (_, i) => ({ type: "llm-call", step: i })) };
    await observer(ev);
    expect((enqueues[0]!.payload.traceEvents as unknown[])).toHaveLength(60);
  });

  it("refine observer：payload.refine=off 不 enqueue", async () => {
    const enqueue = vi.fn(async () => {});
    const observer = createRefineObserver({
      enqueue,
      kernel: { snapshot: async () => ({}) },
      roleId: "developer",
    });
    const ev = event() as unknown as Parameters<TaskOutcomeObserver>[0];
    ev.context = { ...ev.context, task: { id: "task-1", payload: { refine: "off" } } };
    await observer(ev);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refine observer：snapshot 失败记日志并跳过；enqueue 失败抛出（notifyObservers 可见）", async () => {
    const logs: string[] = [];
    const enqueue = vi.fn(async () => { throw new Error("pg down"); });
    const observer = createRefineObserver({
      enqueue,
      kernel: { snapshot: async () => { throw new Error("snapshot boom"); } },
      roleId: "developer",
      logger: (m) => logs.push(m),
    });
    await observer(event());
    expect(logs.some((l) => l.includes("snapshot failed"))).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();

    const observer2 = createRefineObserver({
      enqueue: async () => { throw new Error("enqueue boom"); },
      kernel: { snapshot: async () => ({}) },
      roleId: "developer",
    });
    await expect(observer2(event())).rejects.toThrow("enqueue boom");
  });
});
