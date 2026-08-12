import { describe, it, expect } from "vitest";
import {
  ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, allLineageRoles, buildRoleLineage, renderRoleLineage,
  registerWorkerRole, resetExtraRoles,
} from "../../src/pth/kernel/execution/worker-cluster.js";
import { buildRoleDoc } from "../../src/pth/kernel/prompt-docs.js";

describe("角色谱系树（树状分化——Origin 根 → 任务分化诱导逐代生长）", () => {
  it("Origin 根角色定义（generation=0——无 parent——全能）", () => {
    expect(ORIGIN_ROLE.id).toBe("origin");
    expect(ORIGIN_ROLE.generation).toBe(0);
    expect(ORIGIN_ROLE.parent).toBeUndefined();
    expect(ORIGIN_ROLE.capabilities).toBeUndefined();   // 全能——无访问权限收窄
  });

  it("叶子角色挂中间层/再分化（generation=2 挂三族；memory-stats gen3 分化自 scout——Agent-JIT 路径 B）", () => {
    const midIds = ["executor", "explorer", "governor"];
    for (const r of DEFAULT_ROLES) {
      expect(r.generation).toBeGreaterThanOrEqual(2);
      expect(r.differentiation).toBeTruthy();
    }
    // gen2：父为三族之一
    const gen2 = DEFAULT_ROLES.filter((r) => r.generation === 2);
    expect(gen2.length).toBe(8);   // 7 + writer（2026-08-12 批 2）
    for (const r of gen2) expect(midIds).toContain(r.parent);
    // gen3：memory-stats 分化自 scout（热点任务再收窄——统计窄域）
    const gen3 = DEFAULT_ROLES.filter((r) => r.generation === 3);
    expect(gen3.map((r) => r.id)).toEqual(["memory-stats"]);
    expect(gen3[0]!.parent).toBe("scout");
  });

  it("3 中间层角色挂 Origin（generation=1——族级分化）", () => {
    const midIds = MID_ROLES.map((r) => r.id).sort();
    expect(midIds).toEqual(["executor", "explorer", "governor"]);
    for (const r of MID_ROLES) {
      expect(r.parent).toBe("origin");
      expect(r.generation).toBe(1);
      expect(r.differentiation).toBeTruthy();
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
    // 2026-08-12 体系自制：+9 governance（sensor×4/controller×5——谱系可见默认不派发）
    expect(lineage.length).toBe(DEFAULT_ROLES.length + 1 + 3 + 9);
    const gov = lineage.filter((r) => r.id.startsWith("sensor:") || r.id.startsWith("controller:"));
    expect(gov.length).toBe(9);
  });

  it("buildRoleLineage 构建三层树（Origin → 3 中间层+9 治理骨架 → 8 叶子）", () => {
    const tree = buildRoleLineage();
    expect(tree.role.id).toBe("origin");
    expect(tree.children.length).toBe(3 + 9);   // 3 中间层 + 9 治理骨架（2026-08-12）
    const executor = tree.children.find((c) => c.role.id === "executor");
    const explorer = tree.children.find((c) => c.role.id === "explorer");
    const governor = tree.children.find((c) => c.role.id === "governor");
    expect(executor?.children.map((c) => c.role.id).sort()).toEqual(["developer", "tester", "writer"]);   // writer 2026-08-12 批 2
    expect(explorer?.children.map((c) => c.role.id).sort()).toEqual(["analyst", "scout"]);
    expect(governor?.children.map((c) => c.role.id).sort()).toEqual(["acceptor", "memory-keeper", "planner"]);
  });

  it("扩展角色未填 parent → 挂 Origin 下（兼容——视为初代分化）", () => {
    resetExtraRoles();
    registerWorkerRole({ id: "custom-x", tags: ["quantum-compute"], prompt: "测试角色" });
    const tree = buildRoleLineage();
    const custom = tree.children.find((c) => c.role.id === "custom-x");
    expect(custom).toBeTruthy();
    resetExtraRoles();
  });

  it("三代分化（子角色 parent=叶子角色 → 挂对应子树——developer 在 executor 下）", () => {
    resetExtraRoles();
    registerWorkerRole({ id: "dev-frontend", tags: ["frontend-ui"], prompt: "前端专员", parent: "developer", generation: 3, differentiation: "前端任务诱导" });
    const tree = buildRoleLineage();
    const executor = tree.children.find((c) => c.role.id === "executor");
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
    expect(doc).toContain("谱系代数：2（父角色：executor）");
    expect(doc).toContain("实现类任务诱导");
    const originDoc = buildRoleDoc(ORIGIN_ROLE);
    expect(originDoc).toContain("谱系之根");
  });
});
