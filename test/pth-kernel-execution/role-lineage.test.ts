import { describe, it, expect, beforeEach } from "vitest";
import {
  allLineageRoles, buildRoleLineage, renderRoleLineage,
  registerWorkerRole, resetExtraRoles,
} from "@away_from/pth-kernel-execution";
import { DEFAULT_ROLES, MID_ROLES } from "../../src/pth/impls/roles/default-roles.js";
import { PROFESSIONAL_ROLES } from "@away_from/pth-kernel-execution";
import { installDefaultRoles } from "../helpers.js";

beforeEach(() => installDefaultRoles());
import { buildRoleDoc } from "@away_from/pth-kernel-execution";

describe("角色谱系森林（三源重构——Origin 退役）", () => {
  it("三源根角色定义（generation=0——无 parent）", () => {
    for (const root of ["actuator", "sensor", "controller"]) {
      const r = MID_ROLES.find((x) => x.id === root)!;
      expect(r.generation).toBe(0);
      expect(r.parent).toBeUndefined();
      expect(r.differentiation).toContain("三源之根");
    }
  });

  it("角色按问题类型逐代分化（gen2 挂四族；gen3 挂 developer/analyst；gen4 挂 prospector/tester）", () => {
    const midIds = ["executor", "explorer", "governor", "researcher"];
    for (const r of DEFAULT_ROLES) {
      expect(r.generation).toBeGreaterThanOrEqual(2);
      expect(r.differentiation).toBeTruthy();
    }
    // gen2：父为四族之一（2026-08-24 三源重构顺移 -1）
    const gen2 = DEFAULT_ROLES.filter((r) => r.generation === 2);
    expect(gen2.length).toBe(8);   // analyst/planner/developer/scout/spider/memory-keeper/acceptor/writer
    for (const r of gen2) expect(midIds).toContain(r.parent);
    // gen3：coder/tester 挂 developer；prospector/solver 挂 analyst（问题类型二分）
    const gen3 = DEFAULT_ROLES.filter((r) => r.generation === 3);
    expect(gen3.map((r) => r.id).sort()).toEqual(["coder", "prospector", "solver", "tester"]);
    expect(gen3.filter((r) => r.parent === "developer").map((r) => r.id)).toEqual(["coder", "tester"]);
    expect(gen3.filter((r) => r.parent === "analyst").map((r) => r.id)).toEqual(["prospector", "solver"]);
    // gen4：predictor 挂 prospector（开放探索下的预测专精）；debug-case-writer 挂 tester（P3.6 自修正闭环）
    const gen4 = DEFAULT_ROLES.filter((r) => r.generation === 4);
    expect(gen4.map((r) => r.id).sort()).toEqual(["debug-case-writer", "predictor"]);
    expect(gen4.find((r) => r.id === "predictor")!.parent).toBe("prospector");
    expect(gen4.find((r) => r.id === "debug-case-writer")!.parent).toBe("tester");
  });

  it("7 中间层角色：三源根 generation=0；四族挂 actuator（generation=1——2026-08-24 三源重构）", () => {
    const midIds = MID_ROLES.map((r) => r.id).sort();
    expect(midIds).toEqual(["actuator", "controller", "executor", "explorer", "governor", "researcher", "sensor"]);
    for (const r of MID_ROLES) {
      expect(r.differentiation).toBeTruthy();
    }
    // 三源根：actuator/sensor/controller 无 parent gen0
    for (const root of ["actuator", "sensor", "controller"]) {
      const r = MID_ROLES.find((x) => x.id === root)!;
      expect(r.parent).toBeUndefined();
      expect(r.generation).toBe(0);
    }
    // 四族挂 actuator gen1
    for (const fam of ["executor", "explorer", "governor", "researcher"]) {
      const r = MID_ROLES.find((x) => x.id === fam)!;
      expect(r.parent).toBe("actuator");
      expect(r.generation).toBe(1);
    }
  });

  it("human-interface 不属于 task worker 谱系（PTH Human Interaction 按需调用——任务池不设）", () => {
    expect(DEFAULT_ROLES.some((r) => r.id === "human-interface")).toBe(false);
    expect(allLineageRoles().some((r) => r.id === "human-interface")).toBe(false);
  });

  it("allLineageRoles 不含 origin、含三源根+中间层+治理骨架（allWorkerRoles 不含——batch 构成不变）", () => {
    const lineage = allLineageRoles();
    expect(lineage.some((r) => r.id === "origin")).toBe(false);
    expect(lineage.some((r) => r.id === "actuator")).toBe(true);
    expect(lineage.some((r) => r.id === "executor")).toBe(true);
    // 2026-08-12 体系自制：+10 governance（谱系可见默认不派发）；
    // 2026-08-14 类型树修理：中间层 3 → 7（+actuator/+researcher/+sensor/+controller）
    // 2026-08-18 N14：+6 sensor/controller 点位（13 → 16）
    // v1.3 Task 3：+5 专业角色（谱系可见默认不派发）
    expect(lineage.length).toBe(DEFAULT_ROLES.length + 7 + 16 + PROFESSIONAL_ROLES.length);
    const gov = lineage.filter((r) => r.id.startsWith("sensor:") || r.id.startsWith("controller:"));
    expect(gov.length).toBe(16);
  });

  it("buildRoleLineage 构建三源森林（actuator/sensor/controller 三根 → 4 族 + 16 治理骨架 → 叶子——2026-08-24 三源重构）", () => {
    const roots = buildRoleLineage();
    expect(roots.map((r) => r.role.id).sort()).toEqual(["actuator", "controller", "sensor"]);
    const actuator = roots.find((r) => r.role.id === "actuator")!;
    const controller = roots.find((r) => r.role.id === "controller")!;
    const sensor = roots.find((r) => r.role.id === "sensor")!;
    expect(actuator.children.map((c) => c.role.id).sort()).toEqual(["executor", "explorer", "governor", "researcher"]);
    expect(controller.children.map((c) => c.role.id).sort()).toEqual(["controller:adversarial", "controller:memory", "controller:pth-opt", "controller:resource", "controller:router", "controller:rule", "controller:tool-face", "controller:tool-single", "controller:worker-opt"]);
    expect(sensor.children.map((c) => c.role.id).sort()).toEqual(["sensor:memory", "sensor:resource", "sensor:rule", "sensor:system-opt", "sensor:tool-face", "sensor:tool-single", "sensor:worker-opt"]);
    const executor = actuator.children.find((c) => c.role.id === "executor")!;
    const explorer = actuator.children.find((c) => c.role.id === "explorer")!;
    const governor = actuator.children.find((c) => c.role.id === "governor")!;
    const researcher = actuator.children.find((c) => c.role.id === "researcher")!;
    expect(executor.children.map((c) => c.role.id).sort()).toEqual(["developer", "writer"]);
    expect(explorer.children.map((c) => c.role.id).sort()).toEqual(["scout", "spider"]);
    expect(researcher.children.map((c) => c.role.id).sort()).toEqual(["analyst", "memory-keeper"]);
    expect(governor.children.map((c) => c.role.id).sort()).toEqual(["acceptor", "planner"]);
    const developer = executor.children.find((c) => c.role.id === "developer")!;
    expect(developer.children.map((c) => c.role.id).sort()).toEqual(["assembly-engineer", "coder", "tester"]);
    const tester = developer.children.find((c) => c.role.id === "tester")!;
    expect(tester.children.map((c) => c.role.id)).toEqual(["debug-case-writer"]);
    const writer = executor.children.find((c) => c.role.id === "writer")!;
    expect(writer.children.map((c) => c.role.id)).toEqual(["technical-educator"]);
    const analyst = researcher.children.find((c) => c.role.id === "analyst")!;
    expect(analyst.children.map((c) => c.role.id).sort()).toEqual(["prospector", "solver"]);
    const solver = analyst.children.find((c) => c.role.id === "solver")!;
    expect(solver.children.map((c) => c.role.id).sort()).toEqual(["computational-chemist", "lean4-prover", "symbolic-mathematician"]);
    const prospector = analyst.children.find((c) => c.role.id === "prospector")!;
    expect(prospector.children.map((c) => c.role.id).sort()).toEqual(["predictor"]);
  });

  it("扩展角色未填 parent → 挂第一个根下（兼容——视为初代分化）", () => {
    resetExtraRoles();
    registerWorkerRole({ id: "custom-x", tags: ["quantum-compute"], prompt: "测试角色" });
    const roots = buildRoleLineage();
    const actuator = roots.find((r) => r.role.id === "actuator")!;
    expect(actuator.children.some((c) => c.role.id === "custom-x")).toBe(true);
    resetExtraRoles();
  });

  it("四代分化（子角色 parent=叶子角色 → 挂对应子树——developer 在 executor 下）", () => {
    resetExtraRoles();
    registerWorkerRole({ id: "dev-frontend", tags: ["frontend-ui"], prompt: "前端专员", parent: "developer", generation: 4, differentiation: "前端任务诱导" });
    const roots = buildRoleLineage();
    const actuator = roots.find((r) => r.role.id === "actuator")!;
    const executor = actuator.children.find((c) => c.role.id === "executor")!;
    const dev = executor.children.find((c) => c.role.id === "developer")!;
    expect(dev.children.some((c) => c.role.id === "dev-frontend")).toBe(true);
    resetExtraRoles();
  });

  it("renderRoleLineage 森林渲染（确定性——generation 排序）", () => {
    const text = renderRoleLineage();
    expect(text).toContain("actuator");
    expect(text).toContain("sensor");
    expect(text).toContain("controller");
    expect(text).toContain("├─");
    expect(text).toContain("└─");
    expect(text).toContain("developer");
  });

  it("role-doc 含分化路径段落（谱系元数据——worker 读角色文档见分化来源）", () => {
    const doc = buildRoleDoc(DEFAULT_ROLES.find((r) => r.id === "developer")!);
    expect(doc).toContain("分化路径");
    expect(doc).toContain("谱系代数：2（父角色：executor）");   // 2026-08-24 三源重构顺移 -1
    expect(doc).toContain("实现类任务诱导");
  });
});
