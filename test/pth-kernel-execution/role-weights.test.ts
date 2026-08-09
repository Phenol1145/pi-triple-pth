import { describe, it, expect } from "vitest";
import {
  parseRoleWeights, expandRoleWeights, MAX_WORKER_COPIES,
  profileToWeights, COMPOSITION_STRATEGIES, reinforcedStrategy, weightsToEnv,
} from "../../src/pth/kernel/execution/worker-cluster.js";

describe("batch 构成参数化（PTH_WORKER_ROLES）", () => {
  it("不设置 → 默认 7 角色 ×1", () => {
    const w = parseRoleWeights(undefined);
    expect([...w.values()]).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(expandRoleWeights(w).length).toBe(7);
  });

  it("空串 → 默认", () => {
    expect(expandRoleWeights(parseRoleWeights("")).length).toBe(7);
  });

  it("部分指定：未列出的角色默认 1", () => {
    const w = parseRoleWeights("developer:3,analyst:2");
    expect(w.get("developer")).toBe(3);
    expect(w.get("analyst")).toBe(2);
    expect(w.get("scout")).toBe(1);   // 未列出 → 1
    expect(expandRoleWeights(w).length).toBe(3 + 2 + 5);
  });

  it("副本 0 = 禁用角色（不占 worker）", () => {
    const w = parseRoleWeights("developer:4,planner:0,scout:0,memory-keeper:0,acceptor:0,human-interface:0");
    expect(w.get("planner")).toBe(0);
    const expanded = expandRoleWeights(w);
    expect(expanded.length).toBe(4 + 1);   // developer×4 + analyst×1
    expect(expanded.every((r) => r.id !== "planner")).toBe(true);
  });

  it("未知角色拒绝", () => {
    expect(() => parseRoleWeights("hacker:2")).toThrow(/未知角色/);
  });

  it("副本超上限拒绝", () => {
    expect(() => parseRoleWeights(`developer:${MAX_WORKER_COPIES + 1}`)).toThrow(/副本数/);
  });

  it("重复角色拒绝", () => {
    expect(() => parseRoleWeights("developer:2,developer:1")).toThrow(/重复/);
  });

  it("总 worker 超上限拒绝（32）", () => {
    expect(() => parseRoleWeights("developer:8,analyst:8,planner:8,scout:8,memory-keeper:8,acceptor:8,human-interface:8")).toThrow(/超上限/);
  });

  it("无冒号副本 = 1（developer 等价 developer:1）", () => {
    expect(parseRoleWeights("developer").get("developer")).toBe(1);
  });

  it("副本数为 0 的总数校验正确（0 不占总额）", () => {
    const w = parseRoleWeights("developer:8,analyst:8,planner:8,scout:0,memory-keeper:0,acceptor:0,human-interface:0");
    // 8+8+8+1(默认? 不——全部列出后无默认) —— 实际 developer8+analyst8+planner8 = 24 ≤ 32
    expect(expandRoleWeights(w).length).toBe(24);
  });
});

describe("资源分配策略抽象（BatchCompositionStrategy）", () => {
  it("profileToWeights：balanced 默认 → 7×1", () => {
    const w = profileToWeights({ mode: "balanced" });
    expect([...w.values()]).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("profileToWeights：balanced 自定义权重", () => {
    const w = profileToWeights({ mode: "balanced", weights: { developer: 3, analyst: 2 } });
    expect(w.get("developer")).toBe(3);
    expect(w.get("scout")).toBe(1);
  });

  it("profileToWeights：reinforced 单角色 ×4 其余 0", () => {
    const w = profileToWeights({ mode: "reinforced", role: "developer", copies: 4 });
    expect(w.get("developer")).toBe(4);
    expect(w.get("analyst")).toBe(0);
    expect(w.get("scout")).toBe(0);
    const expanded = expandRoleWeights(w);
    expect(expanded.length).toBe(4);
    expect(expanded.every((r) => r.id === "developer")).toBe(true);
  });

  it("reinforced 超限拒绝（copies > 8）", () => {
    expect(() => profileToWeights({ mode: "reinforced", role: "developer", copies: 9 })).toThrow(/副本数/);
  });

  it("策略注册表：balanced/reinforced 在位", () => {
    expect(Object.keys(COMPOSITION_STRATEGIES).sort()).toEqual(["balanced", "reinforced"]);
  });

  it("reinforcedStrategy.compose：取积压最深角色（descheduler 信号）", () => {
    const p = reinforcedStrategy.compose({ pendingByRole: { developer: 12, scout: 1 }, activeBatches: [], poolCapacity: 16, limits: { maxTotalWorkers: 32 } });
    expect(p).toEqual({ mode: "reinforced", role: "developer", copies: 2 });
  });

  it("weightsToEnv 序列化（PTH_WORKER_ROLES 统一表达）", () => {
    const env = weightsToEnv(profileToWeights({ mode: "reinforced", role: "developer", copies: 2 }));
    expect(env).toContain("developer:2");
    expect(env).toContain("analyst:0");
  });
});

describe("TaskLoop worker 级控制（pause/resume/stop）", () => {
  it("pause 后 runOnce 短路不认领；resume 恢复", async () => {
    const loop = { paused: false, stopped: false } as any;
    const { TaskLoop } = await import("../../src/pth/kernel/execution/task-loop.js");
    const tl = new TaskLoop({} as any, {} as any);
    expect(tl.isPaused).toBe(false);
    tl.pause();
    expect(tl.isPaused).toBe(true);
    tl.resume();
    expect(tl.isPaused).toBe(false);
    tl.stop();
    expect(tl.isStopped).toBe(true);
    void loop;
  });

  it("runOnce 在 paused/stopped 下立即返回 false（不查询）", async () => {
    const { TaskLoop } = await import("../../src/pth/kernel/execution/task-loop.js");
    let queried = 0;
    const tl = new TaskLoop({
      taskStore: { candidates: async () => { queried++; return [{ id: "x" }]; } },
      role: { id: "developer" },
    } as any, {} as any);
    tl.pause();
    expect(await tl.runOnce()).toBe(false);
    expect(queried).toBe(0);   // 短路——零查询
    tl.resume();
    tl.stop();
    expect(await tl.runOnce()).toBe(false);
    expect(queried).toBe(0);
  });
});
