import { describe, expect, it } from "vitest";
import { createWorkerReplica, roleDefinitionRevision, type WorkerReplica } from "../../src/pth/kernel/execution/worker-replica.js";
import type { RoleDefinition } from "../../src/pth/kernel/execution/worker-cluster.js";
import { WorkerSlotRuntime, type WorkerSlotEvent } from "../../src/pth/bootstrap/worker-slot-runtime.js";

const role: RoleDefinition = { id: "researcher", tags: ["research"], prompt: "p" };

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function replica(workerId: string): WorkerReplica {
  return createWorkerReplica("researcher", roleDefinitionRevision(role), "batch-a", () => workerId);
}

describe("WorkerSlotRuntime（生产组件——batch-process 与 harness 共用）", () => {
  it("H1 主证据：busy remove 干净收尾，第二 candidate 不预领，disposer 恰好一次，同角色另一副本不受影响", async () => {
    const events: WorkerSlotEvent[] = [];
    const runtime = new WorkerSlotRuntime({ emit: (event) => events.push(event) });
    const a = replica("10000000-0000-4000-8000-000000000031");
    const b = replica("10000000-0000-4000-8000-000000000032");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let callsA = 0;
    const disposeA = { count: 0 };
    const bRan = { count: 0 };
    runtime.add({
      replica: a,
      role,
      loop: {
        // 模拟真实 TaskLoop：runOnce 内 claim 一个候选、startTask、执行（阻塞）、finally finishTask。
        runOnce: async () => {
          callsA += 1;
          if (callsA > 1) throw new Error("second candidate must never be claimed");
          a.startTask("task-a");
          await gate;
          a.finishTask("task-a");
          return true;
        },
        pause: () => {},
        resume: () => {},
        stop: () => {},
      },
      dispose: async () => { disposeA.count += 1; },
    });
    runtime.add({
      replica: b,
      role,
      loop: {
        runOnce: async () => {
          b.startTask("task-b");
          b.finishTask("task-b");
          bRan.count += 1;
          return true;
        },
        pause: () => {},
        resume: () => {},
        stop: () => {},
      },
      dispose: async () => {},
    });

    expect(runtime.list().map((s) => s.workerId).sort()).toEqual([
      "10000000-0000-4000-8000-000000000031",
      "10000000-0000-4000-8000-000000000032",
    ]);
    const runA = runtime.runOnce(a.ref.workerId);
    await waitUntil(() => a.snapshot().state === "busy");
    // busy 时 remove → stop-after-task intent（draining），不是立即 removed。
    const removeAck = await runtime.handleControl({ type: "worker-remove", workerId: a.ref.workerId });
    expect(removeAck).toMatchObject({ workerId: a.ref.workerId, state: "draining", accepted: true });
    expect(a.snapshot()).toMatchObject({ state: "draining", currentTaskId: "task-a" });
    expect(disposeA.count).toBe(0);

    release();
    await runA;
    // 任务 finally 完成后：stopped → dispose 恰好一次 → slot 移除 → 唯一 worker-removed。
    expect(disposeA.count).toBe(1);
    expect(runtime.list().map((s) => s.workerId)).toEqual([b.ref.workerId]);
    expect(events.filter((e) => e.type === "worker-removed" && e.workerId === a.ref.workerId)).toHaveLength(1);
    expect(events.some((e) => e.type === "worker-status" && e.workerId === a.ref.workerId && e.state === "draining")).toBe(true);
    expect(callsA).toBe(1);   // 同轮未预领第二 candidate；slot 已移除也不会再 runOnce

    // 同角色另一副本继续独立运行。
    expect(await runtime.runOnce(b.ref.workerId)).toBe(true);
    expect(bRan.count).toBe(1);
    expect(b.snapshot().state).toBe("idle");
  });

  it("idle/paused remove 立即 stop+dispose+移除并发唯一 removed 回执", async () => {
    const events: WorkerSlotEvent[] = [];
    const runtime = new WorkerSlotRuntime({ emit: (event) => events.push(event) });
    const r = replica("10000000-0000-4000-8000-000000000033");
    let disposed = 0;
    runtime.add({
      replica: r, role,
      loop: { runOnce: async () => false, pause: () => {}, resume: () => {}, stop: () => {} },
      dispose: async () => { disposed += 1; },
    });
    const ack = await runtime.handleControl({ type: "worker-remove", workerId: r.ref.workerId });
    expect(ack.state).toBe("stopped");
    expect(runtime.list()).toEqual([]);
    expect(disposed).toBe(1);
    expect(events.filter((e) => e.type === "worker-removed" && e.workerId === r.ref.workerId)).toHaveLength(1);
    // 幂等：再 remove 未知 worker → false；dispose 不重复。
    const again = await runtime.handleControl({ type: "worker-remove", workerId: r.ref.workerId });
    expect(again.accepted).toBe(false);
    expect(disposed).toBe(1);
  });

  it("heartbeat 投影完全来自共享 runtime（replicas/tasks 状态一致）", async () => {
    const runtime = new WorkerSlotRuntime({ emit: () => {} });
    const r = replica("10000000-0000-4000-8000-000000000034");
    runtime.add({
      replica: r, role,
      loop: { runOnce: async () => false, pause: () => {}, resume: () => {}, stop: () => {} },
      dispose: async () => {},
    });
    r.startTask("task-x");
    const hb = runtime.heartbeat({ ts: 42, rss: 1, cpuU: 2, cpuS: 3 });
    expect(hb).toEqual({
      type: "status",
      tasks: [{ workerId: r.ref.workerId, taskId: "task-x" }],
      replicas: [r.snapshot()],
      ts: 42, rss: 1, cpuU: 2, cpuS: 3,
    });
    r.finishTask("task-x");
    expect(runtime.heartbeat({ ts: 43, rss: 1, cpuU: 2, cpuS: 3 }).tasks).toEqual([]);
  });

  it("P1-2：heartbeat 可携带 authoritative 责任区/工作集有界投影", () => {
    const runtime = new WorkerSlotRuntime({ emit: () => {} });
    const r = replica("10000000-0000-4000-8000-000000000035");
    runtime.add({
      replica: r, role,
      loop: { runOnce: async () => false, pause: () => {}, resume: () => {}, stop: () => {} },
      dispose: async () => {},
    });
    const hb = runtime.heartbeat(
      { ts: 42, rss: 1, cpuU: 2, cpuS: 3 },
      (workerId) => ({ responsibilities: [{ regionId: "r-1", kind: "primary", priority: 1, regionRevision: 1 }], regionWeights: { "r-1": 3 }, workingSet: { taskId: "t-1", entryIds: ["e-1"], skillIndexIds: ["s-1"], activeSkillIds: [], toolNames: ["memory"], counts: { memoryEntries: 1, skillIndexEntries: 1, activeSkills: 0, tools: 1 }, usage: { memoryEntries: 1, memoryChars: 9, skillIndexEntries: 1, activeSkills: 0, skillChars: 9, tools: 1 }, omitted: {} }, __workerId: workerId }),
    );
    expect(hb.replicas[0]!.authoritative).toMatchObject({
      regionWeights: { "r-1": 3 },
      workingSet: { taskId: "t-1", entryIds: ["e-1"] },
    });
  });
});
