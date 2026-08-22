import { describe, expect, it } from "vitest";
import { roleDefinitionRevision, WorkerReplica } from "@away_from/pth-kernel-execution";
import type { RoleDefinition } from "@away_from/pth-kernel-execution";
import type { WorkerReplicaRef } from "@away_from/pth-contracts";
import { assembleBatchRuntime, runBatchHost } from "../../src/pth/bootstrap/batch-runtime-assembly.js";

const role: RoleDefinition = { id: "researcher", tags: ["research"], prompt: "p" };
const revision = roleDefinitionRevision(role);

const workerA: WorkerReplicaRef = {
  workerId: "10000000-0000-4000-8000-000000000041",
  batchId: "batch-n28",
  role: { roleId: "researcher", revision },
};
const workerB: WorkerReplicaRef = {
  workerId: "10000000-0000-4000-8000-000000000042",
  batchId: "batch-n28",
  role: { roleId: "researcher", revision },
};

describe("assembleBatchRuntime / runBatchHost（生产组合根）", () => {
  it("注入的 replica refs 原样进入 heartbeat/control/principals（无随机 ID）", async () => {
    const emitted: unknown[] = [];
    const sent: unknown[] = [];
    const principals: Array<{ taskPrincipalId: string; sandboxPrincipalId: string; workerId: string }> = [];
    const runtime = assembleBatchRuntime({
      mode: "feasibility",
      batchId: "batch-n28",
      workerSpecs: [
        { role, requestedReplica: workerA },
        { role, requestedReplica: workerB },
      ],
      replicaFactory: (input) => new WorkerReplica(input.requestedReplica ?? {
        workerId: "fallback",
        batchId: input.batchId,
        role: { roleId: input.role.id, revision: roleDefinitionRevision(input.role) },
      }),
      buildSlot: (input) => {
        principals.push({ taskPrincipalId: input.taskPrincipalId, sandboxPrincipalId: input.sandboxPrincipalId, workerId: input.replica!.ref.workerId });
        return {
          replica: input.replica!,
          role: input.role,
          loop: { runOnce: async () => false, pause: () => {}, resume: () => {}, stop: () => {} },
          dispose: async () => {},
        };
      },
      emit: (event) => emitted.push(event),
    });

    expect(runtime.list().map((s) => s.workerId)).toEqual([workerA.workerId, workerB.workerId]);
    expect(principals).toEqual([
      { taskPrincipalId: `worker:${workerA.workerId}`, sandboxPrincipalId: `worker:${workerA.workerId}`, workerId: workerA.workerId },
      { taskPrincipalId: `worker:${workerB.workerId}`, sandboxPrincipalId: `worker:${workerB.workerId}`, workerId: workerB.workerId },
    ]);

    const controls = [
      { type: "worker-pause" as const, workerId: workerA.workerId },
      { type: "worker-resume" as const, workerId: workerA.workerId },
    ];
    await runBatchHost(runtime, {
      maxIterations: 2,
      tickMs: 0,
      send: (msg) => sent.push(msg),
      heartbeatResource: () => ({ ts: 7, rss: 1, cpuU: 2, cpuS: 3 }),
      pollControls: async () => (sent.filter((m) => (m as { type?: string }).type === "status").length === 1 ? controls : []),
    });

    const statuses = sent.filter((m) => (m as { type?: string }).type === "status");
    expect(statuses).toHaveLength(2);
    for (const status of statuses) {
      expect(status).toMatchObject({ type: "status", ts: 7, rss: 1, cpuU: 2, cpuS: 3 });
      expect((status as { replicas: unknown[] }).replicas.map((s) => (s as { workerId: string }).workerId)).toEqual([workerA.workerId, workerB.workerId]);
    }
    const acks = sent.filter((m) => (m as { workerId?: string }).workerId === workerA.workerId);
    expect(acks).toHaveLength(2);
    expect(acks[0]).toMatchObject({ workerId: workerA.workerId, state: "paused", accepted: true });
    expect(acks[1]).toMatchObject({ workerId: workerA.workerId, state: "idle", accepted: true });
    expect(emitted.filter((e) => (e as { type?: string }).type === "worker-status")).toHaveLength(2);
  });

  it("拒绝重复 workerId / batch mismatch / role id mismatch / revision mismatch", () => {
    const base = {
      mode: "feasibility" as const,
      batchId: "batch-n28",
      buildSlot: () => ({ replica: workerA as never, role, loop: { runOnce: async () => false, pause: () => {}, resume: () => {}, stop: () => {} }, dispose: async () => {} }),
    };
    expect(() => assembleBatchRuntime({
      ...base,
      workerSpecs: [
        { role, requestedReplica: workerA },
        { role, requestedReplica: workerA },
      ],
    })).toThrow(/duplicate worker id/);
    expect(() => assembleBatchRuntime({
      ...base,
      batchId: "other-batch",
      workerSpecs: [{ role, requestedReplica: workerA }],
    })).toThrow(/batch mismatch/);
    expect(() => assembleBatchRuntime({
      ...base,
      workerSpecs: [{ role, requestedReplica: { ...workerA, role: { roleId: "analyst", revision } } }],
    })).toThrow(/role id mismatch/);
    expect(() => assembleBatchRuntime({
      ...base,
      workerSpecs: [{ role: { ...role, prompt: "changed" }, requestedReplica: workerA }],
    })).toThrow(/role revision mismatch/);
  });

  it("off 模式 assembly 不建 slot（legacy 无新控制面）", () => {
    const runtime = assembleBatchRuntime({ mode: "off", batchId: "batch-a", workerSpecs: [{ role }] });
    expect(runtime.list()).toEqual([]);
  });
});
