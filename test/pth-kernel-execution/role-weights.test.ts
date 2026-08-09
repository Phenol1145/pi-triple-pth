import { describe, it, expect } from "vitest";
import { parseRoleWeights, expandRoleWeights, MAX_WORKER_COPIES } from "../../src/pth/kernel/execution/worker-cluster.js";

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
