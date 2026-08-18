import { describe, it, expect } from "vitest";
import { createWorkerCluster, type WorkerRole } from "../../src/pth/kernel/execution/worker-cluster";
import { DEFAULT_ROLES } from "../../src/pth/impls/roles/default-roles";
import { installDefaultRoles } from "../helpers";

beforeEach(() => installDefaultRoles());

describe("worker cluster", () => {
  it("DEFAULT_ROLES has 14 roles with unique ids（+coder/+spider/+prospector/+solver/+predictor 2026-08-14——问题类型二分；memory-stats 退役；+debug-case-writer 2026-08-15 P3.6）", () => {
    expect(DEFAULT_ROLES.length).toBe(14);
    const ids = new Set(DEFAULT_ROLES.map((r) => r.id));
    expect(ids.size).toBe(14);
    // 自持态角色集（analyst 升中间层：prospector/solver 二分 + predictor 预测专精）
    expect(ids).toEqual(new Set(["analyst", "planner", "developer", "coder", "scout", "spider", "memory-keeper", "acceptor", "tester", "debug-case-writer", "writer", "prospector", "solver", "predictor"]));
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
    expect(cluster.size).toBe(15);   // origin + 14 默认角色（2026-08-14 +coder/+spider/+prospector/+solver/+predictor；2026-08-15 +debug-case-writer）
    expect(calls).toBe(15);
    expect(cluster.has("developer")).toBe(true);
  });

  it("kernelFactory receives the role", () => {
    const seen: string[] = [];
    createWorkerCluster({
      kernelFactory: (role: WorkerRole) => { seen.push(role.id); return { reset: () => {}, dispose: () => {} } as any; },
      taskStore: {} as any,
      workspaceMgr: {} as any,
    });
    expect(seen.sort()).toEqual(["acceptor", "analyst", "coder", "debug-case-writer", "developer", "memory-keeper", "origin", "planner", "predictor", "prospector", "scout", "solver", "spider", "tester", "writer"]);
  });
});

describe("时间复用率（2026-08-13 监测量——planner 计划扁平化）", () => {
  it("computeTimeReuse：全并行 → 高复用；全串行 → 0；单任务 → null", async () => {
    const { computeTimeReuse } = await import("../../src/pth/kernel/execution/worker-scorecard.js");
    // 全并行：3 任务互不依赖——关键路径 1——复用率 0.67
    expect(computeTimeReuse([
      { id: "a", dependsOn: [] }, { id: "b", dependsOn: [] }, { id: "c", dependsOn: [] },
    ])).toBe(0.67);
    // 全串行链：关键路径 3——复用率 0
    expect(computeTimeReuse([
      { id: "a", dependsOn: [] }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] },
    ])).toBe(0);
    // 单任务/空 → null（无复用概念）
    expect(computeTimeReuse([{ id: "a" }])).toBeNull();
    expect(computeTimeReuse(undefined)).toBeNull();
  });

  it("detectHotspots：低复用窗口 → plan-deep 建议；无计划/高复用 → 无", async () => {
    const { detectHotspots } = await import("../../src/pth/kernel/execution/optimizer-loop.js");
    const base = { steps: 3, toolFreq: {}, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, failedActions: 0, gatedActions: 0, aspNav: { cds: 0, indexes: 0 }, finish: { ok: true } };
    const lowReuse = { ...base, timeReuse: 0.2 };
    const highReuse = { ...base, timeReuse: 0.6 };
    expect(detectHotspots([lowReuse]).some((h) => h.pattern === "plan-deep")).toBe(true);
    expect(detectHotspots([highReuse]).some((h) => h.pattern === "plan-deep")).toBe(false);
    expect(detectHotspots([base]).some((h) => h.pattern === "plan-deep")).toBe(false);
  });
});

describe("worker-index 渲染（2026-08-13——planner 的 worker 类型获取通道）", () => {
  it("渲染含全部可派发角色（内置+扩展——id/标签/代数/职责一行）", async () => {
    const { renderWorkerIndex, registerWorkerRole, resetExtraRoles, allWorkerRoles } = await import("../../src/pth/kernel/execution/worker-cluster.js");
    registerWorkerRole({
      id: "wi-probe", tags: ["probe-tag"], prompt: "p", description: "探针角色", parent: "origin", generation: 1, differentiation: "测试",
    } as never);
    const text = renderWorkerIndex();
    expect(text).toContain("可用 worker 角色清单");
    expect(text).toContain("developer");
    expect(text).toContain("planner");
    expect(text).toContain("wi-probe [probe-tag] gen1");   // 扩展角色也入清单
    expect(allWorkerRoles().length).toBeGreaterThan(10);
    resetExtraRoles();
  });
});

describe("RoleDefinition 兼容名（N28 T1）", () => {
  it("keeps WorkerRole as a compatibility alias for RoleDefinition", () => {
    const role: import("../../src/pth/kernel/execution/worker-cluster.js").RoleDefinition = {
      id: "compat-role",
      tags: ["compat"],
      prompt: "compat",
    };
    const legacy: import("../../src/pth/kernel/execution/worker-cluster.js").WorkerRole = role;
    expect(legacy.id).toBe("compat-role");
  });
});
