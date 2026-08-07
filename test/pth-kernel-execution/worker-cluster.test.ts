import { describe, it, expect } from "vitest";
import { DEFAULT_ROLES, createWorkerCluster, type WorkerRole } from "../../src/pth/kernel/execution/worker-cluster";

describe("worker cluster", () => {
  it("DEFAULT_ROLES has 7 roles with unique ids", () => {
    expect(DEFAULT_ROLES.length).toBe(7);
    const ids = new Set(DEFAULT_ROLES.map((r) => r.id));
    expect(ids.size).toBe(7);
    // 自持态角色集
    expect(ids).toEqual(new Set(["analyst", "planner", "developer", "scout", "memory-keeper", "acceptor", "human-interface"]));
  });

  it("each role has labelPatterns and prompt", () => {
    for (const r of DEFAULT_ROLES) {
      expect(r.labelPatterns.length).toBeGreaterThan(0);
      expect(r.prompt.length).toBeGreaterThan(0);
    }
  });

  it("createWorkerCluster creates one kernel per role", () => {
    let calls = 0;
    const cluster = createWorkerCluster({
      kernelFactory: () => { calls++; return { reset: () => {}, dispose: () => {} } as any; },
      taskStore: {} as any,
      workspaceMgr: {} as any,
    });
    expect(cluster.size).toBe(7);
    expect(calls).toBe(7);
    expect(cluster.has("developer")).toBe(true);
  });

  it("kernelFactory receives the role", () => {
    const seen: string[] = [];
    createWorkerCluster({
      kernelFactory: (role: WorkerRole) => { seen.push(role.id); return { reset: () => {}, dispose: () => {} } as any; },
      taskStore: {} as any,
      workspaceMgr: {} as any,
    });
    expect(seen.sort()).toEqual(["acceptor", "analyst", "developer", "human-interface", "memory-keeper", "planner", "scout"]);
  });
});
