import { describe, it, expect } from "vitest";
import { DEFAULT_ROLES, createWorkerCluster, type WorkerRole } from "../../src/pth/kernel/execution/worker-cluster";

describe("worker cluster", () => {
  it("DEFAULT_ROLES has 8 leaf roles with unique ids（human-interface 移除——PTL 负责人类交互；memory-stats 2026-08-11 Agent-JIT 分化）", () => {
    expect(DEFAULT_ROLES.length).toBe(8);
    const ids = new Set(DEFAULT_ROLES.map((r) => r.id));
    expect(ids.size).toBe(8);
    // 自持态角色集（+tester——功能测试通用角色）
    expect(ids).toEqual(new Set(["analyst", "planner", "developer", "scout", "memory-keeper", "memory-stats", "acceptor", "tester"]));
  });

  it("each role has tags and prompt", () => {
    for (const r of DEFAULT_ROLES) {
      expect(r.tags.length).toBeGreaterThan(0);
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
    expect(cluster.size).toBe(9);   // origin + 8 默认角色（2026-08-11 memory-stats Agent-JIT 分化）
    expect(calls).toBe(9);
    expect(cluster.has("developer")).toBe(true);
  });

  it("kernelFactory receives the role", () => {
    const seen: string[] = [];
    createWorkerCluster({
      kernelFactory: (role: WorkerRole) => { seen.push(role.id); return { reset: () => {}, dispose: () => {} } as any; },
      taskStore: {} as any,
      workspaceMgr: {} as any,
    });
    expect(seen.sort()).toEqual(["acceptor", "analyst", "developer", "memory-keeper", "memory-stats", "origin", "planner", "scout", "tester"]);
  });
});
