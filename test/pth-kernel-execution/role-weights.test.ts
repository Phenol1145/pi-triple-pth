import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { installDefaultRoles } from "../helpers";
import {
  parseRoleWeights, expandRoleWeights, MAX_WORKER_COPIES,
  profileToWeights, COMPOSITION_STRATEGIES, reinforcedStrategy, weightsToEnv,
  registerWorkerRole, resetExtraRoles, validateWeights,
} from "@away_from/pth-kernel-execution";

beforeEach(() => installDefaultRoles());

describe("batch 构成参数化（PTH_WORKER_ROLES）", () => {
  it("不设置 → 默认 14 角色 ×1（Origin 退役——2026-08-24；专业角色 explicit-only=0）", () => {
    const w = parseRoleWeights(undefined);
    expect([...w.values()]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    expect(expandRoleWeights(w).length).toBe(14);
  });

  it("空串 → 默认", () => {
    expect(expandRoleWeights(parseRoleWeights("")).length).toBe(14);
  });

  it("部分指定：未列出的角色默认 1", () => {
    const w = parseRoleWeights("developer:3,analyst:2");
    expect(w.get("developer")).toBe(3);
    expect(w.get("analyst")).toBe(2);
    expect(w.get("scout")).toBe(1);   // 未列出 → 1
    expect(expandRoleWeights(w).length).toBe(3 + 2 + 12);  // 2 列出 + 其余 12 角色未列默认 1×12
  });

  it("副本 0 = 禁用角色（不占 worker）", () => {
    const w = parseRoleWeights("developer:4,planner:0,scout:0,memory-keeper:0,acceptor:0,tester:0");
    expect(w.get("planner")).toBe(0);
    const expanded = expandRoleWeights(w);
    expect(expanded.length).toBe(4 + 8);   // developer×4 + 其余 8 角色未列默认 1（14 角色谱系，5 角色禁用）
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
    expect(() => parseRoleWeights("developer:8,analyst:8,planner:8,scout:8,memory-keeper:8,acceptor:8,tester:8")).toThrow(/超上限/);
  });

  it("无冒号副本 = 1（developer 等价 developer:1）", () => {
    expect(parseRoleWeights("developer").get("developer")).toBe(1);
  });

  it("副本数为 0 的总数校验正确（0 不占总额）", () => {
    const w = parseRoleWeights("developer:8,analyst:8,planner:8,scout:0,memory-keeper:0,acceptor:0,tester:0");
    // developer8+analyst8+planner8+未列默认 1×7（prospector+solver+predictor+coder+spider+debug-case-writer+writer） = 31 ≤ 32
    expect(expandRoleWeights(w).length).toBe(31);
  });
});

describe("资源分配策略抽象（BatchCompositionStrategy）", () => {
  it("profileToWeights：balanced 默认 → 14×1（Origin 退役）+ 专业角色 0", () => {
    const w = profileToWeights({ mode: "balanced" });
    expect([...w.values()]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
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
    const { TaskLoop } = await import("../../src/pth/bootstrap/task-loop.js");
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
    const { TaskLoop } = await import("../../src/pth/bootstrap/task-loop.js");
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

describe("正交角色谱系整理（2026-08-09：扩展角色完整融入 batch 构成）", () => {
  afterEach(() => { resetExtraRoles(); });

  it("扩展角色可进 PTH_WORKER_ROLES 配置（parse/expand 统一谱系）", () => {
    registerWorkerRole({ id: "greeting-agent", tags: ["greeting", "hello"], prompt: "问候专员", capabilities: ["memory", "fs", "ext"], memoryScope: "own" });
    // 解析含扩展角色
    const w = parseRoleWeights("greeting-agent:2,developer:1");
    expect(w.get("greeting-agent")).toBe(2);
    expect(w.get("developer")).toBe(1);
    // 展开含扩展角色 worker
    const roles = expandRoleWeights(w);
    expect(roles.filter((r) => r.id === "greeting-agent")).toHaveLength(2);
    expect(roles.filter((r) => r.id === "developer")).toHaveLength(1);
    // 未列出角色默认 1（含扩展）
    const full = parseRoleWeights("developer:1");
    expect(full.get("greeting-agent")).toBe(1);
  });

  it("profileToWeights reinforced 支持扩展角色（其余 0）", () => {
    registerWorkerRole({ id: "greeting-agent", tags: ["greeting"], prompt: "p" });
    const w = profileToWeights({ mode: "reinforced", role: "greeting-agent", copies: 3 });
    expect(w.get("greeting-agent")).toBe(3);
    expect(w.get("developer")).toBe(0);
    // env 序列化含扩展角色
    expect(weightsToEnv(w)).toContain("greeting-agent:3");
  });

  it("validateWeights 接受扩展角色副本", () => {
    registerWorkerRole({ id: "greeting-agent", tags: ["greeting"], prompt: "p" });
    expect(() => validateWeights(new Map([["greeting-agent", 4]]))).not.toThrow();
  });

  it("扩展角色默认 1 副本（空配置含扩展）", () => {
    registerWorkerRole({ id: "greeting-agent", tags: ["greeting"], prompt: "p" });
    const w = parseRoleWeights(undefined);
    expect(w.get("greeting-agent")).toBe(1);
  });
});

describe("专业角色 explicit-only（v1.3 Task 3——不进缺省单副本循环）", () => {
  it("PTH_WORKER_ROLES 缺省 → 五个专业角色零副本", () => {
    const w = parseRoleWeights(undefined);
    const ids = ["assembly-engineer", "computational-chemist", "lean4-prover", "symbolic-mathematician", "technical-educator"];
    for (const id of ids) expect(w.get(id)).toBe(0);
    expect(expandRoleWeights(w).some((r) => ids.includes(r.id))).toBe(false);
  });

  it("PTH_WORKER_ROLES 显式列出专业角色 → 可解析并展开", () => {
    const w = parseRoleWeights("assembly-engineer:2,lean4-prover:1");
    expect(w.get("assembly-engineer")).toBe(2);
    expect(w.get("lean4-prover")).toBe(1);
    const expanded = expandRoleWeights(w);
    expect(expanded.filter((r) => r.id === "assembly-engineer")).toHaveLength(2);
    expect(expanded.filter((r) => r.id === "lean4-prover")).toHaveLength(1);
  });
});

describe("governance 角色显式启用（2026-08-12 expand 修复）", () => {
  it("PTH_WORKER_ROLES 显式列出 controller:worker-opt → batch 含该角色（旧实现静默丢弃）", () => {
    const w = parseRoleWeights("controller:worker-opt:1");
    expect(w.get("controller:worker-opt")).toBe(1);
    const expanded = expandRoleWeights(w);
    expect(expanded.some((r) => r.id === "controller:worker-opt")).toBe(true);
    expect(expanded.length).toBe(15);   // 14 默认 + 1 governance
  });

  it("governance 0 副本 → 过滤（不展开）", () => {
    const w = parseRoleWeights("sensor:worker-opt:0");
    expect(w.get("sensor:worker-opt")).toBe(0);
    expect(expandRoleWeights(w).some((r) => r.id === "sensor:worker-opt")).toBe(false);
  });

  it("governance + 默认全部（含 MID 显式）", () => {
    const w = parseRoleWeights("executor:2,controller:router:1");
    const expanded = expandRoleWeights(w);
    expect(expanded.filter((r) => r.id === "executor").length).toBe(2);
    expect(expanded.some((r) => r.id === "controller:router")).toBe(true);
  });
});
