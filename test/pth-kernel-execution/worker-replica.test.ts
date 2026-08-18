import { describe, expect, it } from "vitest";
import { createWorkerReplica, roleDefinitionRevision } from "../../src/pth/kernel/execution/worker-replica.js";

describe("WorkerReplica", () => {
  it("creates independently addressable replicas for the same role", () => {
    const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
    const a = createWorkerReplica("researcher", "catalog-v1", "batch-a", () => ids.shift()!);
    const b = createWorkerReplica("researcher", "catalog-v1", "batch-a", () => ids.shift()!);
    expect(a.ref.role).toEqual(b.ref.role);
    expect(a.ref.workerId).not.toBe(b.ref.workerId);
    expect(Object.isFrozen(a.ref.role)).toBe(true);
    a.pause();
    expect(a.snapshot().state).toBe("paused");
    expect(b.snapshot().state).toBe("idle");
  });

  it("allows one current task and returns to idle after completion", () => {
    const replica = createWorkerReplica("researcher", "catalog-v1", "batch-a", () => "10000000-0000-4000-8000-000000000003");
    replica.startTask("task-a");
    expect(replica.snapshot()).toMatchObject({ state: "busy", currentTaskId: "task-a" });
    expect(() => replica.startTask("task-b")).toThrow(/already busy/);
    replica.finishTask("task-a");
    expect(replica.snapshot()).toMatchObject({ state: "idle", currentTaskId: undefined });
  });

  it("preserves a pause requested while busy", () => {
    const replica = createWorkerReplica("researcher", "catalog-v1", "batch-a", () => "10000000-0000-4000-8000-000000000004");
    replica.startTask("task-a");
    replica.pause();
    expect(replica.snapshot()).toMatchObject({ state: "draining", currentTaskId: "task-a" });
    replica.finishTask("task-a");
    expect(replica.snapshot()).toMatchObject({ state: "paused", currentTaskId: undefined });
  });

  it("versions one role from its canonical definition rather than an unrelated catalog", () => {
    const role = { id: "researcher", tags: ["research"], prompt: "p" };
    expect(roleDefinitionRevision({ prompt: "p", tags: ["research"], id: "researcher" })).toBe(roleDefinitionRevision(role));
    expect(roleDefinitionRevision({ ...role, prompt: "changed" })).not.toBe(roleDefinitionRevision(role));
  });
});
