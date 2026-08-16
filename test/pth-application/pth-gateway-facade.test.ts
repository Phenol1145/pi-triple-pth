import { describe, expect, it } from "vitest";
import { createPthGatewayFacade, type PthGatewayFacade } from "../../src/pth/application/gateway/pth-gateway-facade.js";
import type { KernelRuntime } from "../../src/pth/kernel/assembly.js";

function fakeKernel(): KernelRuntime {
  return {
    pool: { query: async () => ({ rows: [] }) } as never,
    dataWorld: {
      tasks: {
        publish: async (input: unknown) => ({ id: "t-1", status: "pending", ...(input as object) }),
        candidates: async () => [],
        countPending: async () => 0,
      },
      memory: {
        retrieve: async () => [],
        get: async () => undefined,
        write: async () => {},
      },
      transcripts: { listByTask: async () => [] },
      queryReadOnly: async () => [],
    } as never,
    batchManager: {
      spawnBatch: async () => ({ id: "b-1", pid: 42, workers: ["analyst"], currentTasks: new Map(), idleRatio: 1 }),
      listBatches: async () => [],
      isBatchAlive: () => true,
    } as never,
    watchdog: { getCrashLog: () => [] } as never,
    triggerEngine: { reload: async () => 0 } as never,
    execChannel: { execute: async () => ({ ok: true }) } as never,
    activityHub: { stream: () => ({} as never) } as never,
    shutdown: async () => {},
  } as unknown as KernelRuntime;
}

describe("PthGatewayFacade（P0-3）", () => {
  it("只暴露 route-shape 方法，不暴露 pool/dataWorld/batchManager", () => {
    const facade: PthGatewayFacade = createPthGatewayFacade(fakeKernel());
    expect(typeof facade.publishTask).toBe("function");
    expect(typeof facade.listTasks).toBe("function");
    expect(typeof facade.getTask).toBe("function");
    expect(typeof facade.spawnBatches).toBe("function");
    expect(typeof facade.taskCounts).toBe("function");
    expect(typeof facade.retrieveMemory).toBe("function");

    expect("pool" in facade).toBe(false);
    expect("dataWorld" in facade).toBe(false);
    expect("batchManager" in facade).toBe(false);
    expect(Object.keys(facade)).toHaveLength(0);
  });

  it("publishTask 委托底层 tasks.publish 并保留输入形状", async () => {
    const facade = createPthGatewayFacade(fakeKernel());
    const task = await facade.publishTask({
      title: "t", text: "code", createdBy: "user", tags: ["code"],
      payload: { flow: { stages: [] } }, tenantId: "tenant-a",
    });
    expect(task.id).toBe("t-1");
    expect(task).toMatchObject({ title: "t", tenantId: "tenant-a" });
  });

  it("spawnBatches 委托 batchManager 并返回 route 形状", async () => {
    const facade = createPthGatewayFacade(fakeKernel());
    const result = await facade.spawnBatches(2, { mode: "reinforced", role: "analyst", copies: 1 });
    expect(result.spawned).toBe(2);
    expect(result.batches.map((b) => b.id)).toEqual(["b-1", "b-1"]);
  });
});
