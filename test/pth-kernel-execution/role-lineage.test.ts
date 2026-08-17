import { describe, it, expect } from "vitest";
import {
  allLineageRoles, buildRoleLineage, renderRoleLineage,
  registerWorkerRole, resetExtraRoles,
} from "../../src/pth/kernel/execution/worker-cluster.js";
import { ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES } from "../../src/pth/impls/roles/default-roles";
import { installDefaultRoles } from "../helpers";

beforeEach(() => installDefaultRoles());
import { buildRoleDoc } from "../../src/pth/kernel/prompt-docs.js";

describe("角色谱系树（树状分化——Origin 根 → 任务分化诱导逐代生长）", () => {
  it("Origin 根角色定义（generation=0——无 parent——全能）", () => {
    expect(ORIGIN_ROLE.id).toBe("origin");
    expect(ORIGIN_ROLE.generation).toBe(0);
    expect(ORIGIN_ROLE.parent).toBeUndefined();
    expect(ORIGIN_ROLE.capabilities).toBeUndefined();   // 全能——无访问权限收窄
  });

  it("角色按问题类型逐代分化（gen3 挂四族；gen4 挂 developer/analyst；gen5 挂 prospector）", () => {
    const midIds = ["executor", "explorer", "governor", "researcher"];
    for (const r of DEFAULT_ROLES) {
      expect(r.generation).toBeGreaterThanOrEqual(3);
      expect(r.differentiation).toBeTruthy();
    }
    // gen3：父为四族之一（2026-08-14 类型树修理：actuator 插入后整层 +1）
    const gen3 = DEFAULT_ROLES.filter((r) => r.generation === 3);
    expect(gen3.length).toBe(8);   // analyst/planner/developer/scout/spider/memory-keeper/acceptor/writer
    for (const r of gen3) expect(midIds).toContain(r.parent);
    // gen4：coder/tester 挂 developer；prospector/solver 挂 analyst（问题类型二分）
    const gen4 = DEFAULT_ROLES.filter((r) => r.generation === 4);
    expect(gen4.map((r) => r.id).sort()).toEqual(["coder", "prospector", "solver", "tester"]);
    expect(gen4.filter((r) => r.parent === "developer").map((r) => r.id)).toEqual(["coder", "tester"]);
    expect(gen4.filter((r) => r.parent === "analyst").map((r) => r.id)).toEqual(["prospector", "solver"]);
    // gen5：predictor 挂 prospector（开放探索下的预测专精）；debug-case-writer 挂 tester（P3.6 自修正闭环）
    const gen5 = DEFAULT_ROLES.filter((r) => r.generation === 5);
    expect(gen5.map((r) => r.id).sort()).toEqual(["debug-case-writer", "predictor"]);
    expect(gen5.find((r) => r.id === "predictor")!.parent).toBe("prospector");
    expect(gen5.find((r) => r.id === "debug-case-writer")!.parent).toBe("tester");
  });

  it("7 中间层角色：控制论三元组 sensor/controller/actuator 挂 Origin（generation=1）；四族挂 actuator（generation=2——2026-08-14 sensor/controller 升格真实类型）", () => {
    const midIds = MID_ROLES.map((r) => r.id).sort();
    expect(midIds).toEqual(["actuator", "controller", "executor", "explorer", "governor", "researcher", "sensor"]);
    for (const r of MID_ROLES) {
      expect(r.differentiation).toBeTruthy();
    }
    // 控制论三元组根：actuator/sensor/controller 挂 Origin gen1
    for (const root of ["actuator", "sensor", "controller"]) {
      const r = MID_ROLES.find((x) => x.id === root)!;
      expect(r.parent).toBe("origin");
      expect(r.generation).toBe(1);
    }
    // 四族挂 actuator gen2
    for (const fam of ["executor", "explorer", "governor", "researcher"]) {
      const r = MID_ROLES.find((x) => x.id === fam)!;
      expect(r.parent).toBe("actuator");
      expect(r.generation).toBe(2);
    }
  });

  it("human-interface 已移除（PTL 负责人类交互——PTH 任务池不设）", () => {
    expect(DEFAULT_ROLES.some((r) => r.id === "human-interface")).toBe(false);
    expect(allLineageRoles().some((r) => r.id === "human-interface")).toBe(false);
  });

  it("allLineageRoles 含 Origin+中间层+治理骨架（allWorkerRoles 不含——batch 构成不变）", () => {
    const lineage = allLineageRoles();
    expect(lineage.some((r) => r.id === "origin")).toBe(true);
    expect(lineage.some((r) => r.id === "executor")).toBe(true);
    // 2026-08-12 体系自制：+10 governance（谱系可见默认不派发）；
    // 2026-08-14 类型树修理：中间层 3 → 7（+actuator/+researcher/+sensor/+controller）
    // 2026-08-18 N14：+6 sensor/controller 点位（13 → 16）
    expect(lineage.length).toBe(DEFAULT_ROLES.length + 1 + 7 + 16);
    const gov = lineage.filter((r) => r.id.startsWith("sensor:") || r.id.startsWith("controller:"));
    expect(gov.length).toBe(16);
  });

  it("buildRoleLineage 构建四层树（Origin → sensor/controller/actuator 三元组 → 4 族 + 16 治理骨架 → 10 叶子——2026-08-14 类型树修理 + B4 W7 + 2026-08-18 N14 六点位）", () => {
    const tree = buildRoleLineage();
    expect(tree.role.id).toBe("origin");
    expect(tree.children.map((c) => c.role.id).sort()).toEqual(["actuator", "controller", "sensor"]);   // 控制论三元组（真实类型）
    const actuator = tree.children.find((c) => c.role.id === "actuator");
    const controller = tree.children.find((c) => c.role.id === "controller");
    const sensor = tree.children.find((c) => c.role.id === "sensor");
    expect(actuator?.children.map((c) => c.role.id).sort()).toEqual(["executor", "explorer", "governor", "researcher"]);
    expect(controller?.children.map((c) => c.role.id).sort()).toEqual(["controller:adversarial", "controller:memory", "controller:pth-opt", "controller:resource", "controller:router", "controller:rule", "controller:tool-face", "controller:tool-single", "controller:worker-opt"]);
    expect(sensor?.children.map((c) => c.role.id).sort()).toEqual(["sensor:memory", "sensor:resource", "sensor:rule", "sensor:system-opt", "sensor:tool-face", "sensor:tool-single", "sensor:worker-opt"]);   // 2026-08-18 N14 P1：+tool-face/tool-single/rule
    const executor = actuator?.children.find((c) => c.role.id === "executor");
    const explorer = actuator?.children.find((c) => c.role.id === "explorer");
    const governor = actuator?.children.find((c) => c.role.id === "governor");
    const researcher = actuator?.children.find((c) => c.role.id === "researcher");
    expect(executor?.children.map((c) => c.role.id).sort()).toEqual(["developer", "writer"]);   // tester 迁入 developer（2026-08-14）
    expect(explorer?.children.map((c) => c.role.id).sort()).toEqual(["scout", "spider"]);   // spider 2026-08-14 抓取专精
    expect(researcher?.children.map((c) => c.role.id).sort()).toEqual(["analyst", "memory-keeper"]);   // memory-keeper 迁入 researcher（2026-08-14）
    expect(governor?.children.map((c) => c.role.id).sort()).toEqual(["acceptor", "planner"]);   // memory-keeper 迁出（2026-08-14）
    const developer = executor?.children.find((c) => c.role.id === "developer");
    expect(developer?.children.map((c) => c.role.id).sort()).toEqual(["coder", "tester"]);   // coder/tester 子类型（2026-08-14）
    const tester = developer?.children.find((c) => c.role.id === "tester");
    expect(tester?.children.map((c) => c.role.id)).toEqual(["debug-case-writer"]);   // P3.6 调试用例专精（2026-08-15）
    const analyst = researcher?.children.find((c) => c.role.id === "analyst");
    expect(analyst?.children.map((c) => c.role.id).sort()).toEqual(["prospector", "solver"]);   // 问题类型二分：开放探索/封闭限制（2026-08-14）
    const prospector = analyst?.children.find((c) => c.role.id === "prospector");
    expect(prospector?.children.map((c) => c.role.id).sort()).toEqual(["predictor"]);   // 开放探索下的预测专精（2026-08-14）
  });

  it("扩展角色未填 parent → 挂 Origin 下（兼容——视为初代分化）", () => {
    resetExtraRoles();
    registerWorkerRole({ id: "custom-x", tags: ["quantum-compute"], prompt: "测试角色" });
    const tree = buildRoleLineage();
    const custom = tree.children.find((c) => c.role.id === "custom-x");
    expect(custom).toBeTruthy();
    resetExtraRoles();
  });

  it("四代分化（子角色 parent=叶子角色 → 挂对应子树——developer 在 executor 下）", () => {
    resetExtraRoles();
    registerWorkerRole({ id: "dev-frontend", tags: ["frontend-ui"], prompt: "前端专员", parent: "developer", generation: 4, differentiation: "前端任务诱导" });
    const tree = buildRoleLineage();
    const actuator = tree.children.find((c) => c.role.id === "actuator");
    const executor = actuator?.children.find((c) => c.role.id === "executor");
    const dev = executor?.children.find((c) => c.role.id === "developer");
    expect(dev?.children.some((c) => c.role.id === "dev-frontend")).toBe(true);
    resetExtraRoles();
  });

  it("renderRoleLineage 树形渲染（确定性——generation 排序）", () => {
    const text = renderRoleLineage();
    expect(text).toContain("origin");
    expect(text).toContain("├─");
    expect(text).toContain("└─");
    expect(text).toContain("developer");
  });

  it("role-doc 含分化路径段落（谱系元数据——worker 读角色文档见分化来源）", () => {
    const doc = buildRoleDoc(DEFAULT_ROLES.find((r) => r.id === "developer")!);
    expect(doc).toContain("分化路径");
    expect(doc).toContain("谱系代数：3（父角色：executor）");   // 2026-08-14 类型树修理：actuator 插入后 +1
    expect(doc).toContain("实现类任务诱导");
    const originDoc = buildRoleDoc(ORIGIN_ROLE);
    expect(originDoc).toContain("谱系之根");
  });
});
