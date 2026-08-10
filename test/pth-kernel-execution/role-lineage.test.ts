import { describe, it, expect } from "vitest";
import {
  ORIGIN_ROLE, DEFAULT_ROLES, allLineageRoles, buildRoleLineage, renderRoleLineage,
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

  it("8 内置角色追溯为 Origin 初代分化（parent=origin / generation=1 / 有诱导理由）", () => {
    for (const r of DEFAULT_ROLES) {
      expect(r.parent).toBe("origin");
      expect(r.generation).toBe(1);
      expect(r.differentiation).toBeTruthy();
    }
  });

  it("allLineageRoles 含 Origin 根（allWorkerRoles 不含——batch 构成不变）", () => {
    const lineage = allLineageRoles();
    expect(lineage.some((r) => r.id === "origin")).toBe(true);
    expect(lineage.length).toBe(DEFAULT_ROLES.length + 1);
  });

  it("buildRoleLineage 构建树（Origin 根——8 初代子节点）", () => {
    const tree = buildRoleLineage();
    expect(tree.role.id).toBe("origin");
    expect(tree.children.length).toBe(DEFAULT_ROLES.length);
    expect(tree.children.every((c) => c.children.length === 0)).toBe(true);   // 当前全部初代——无二代
  });

  it("扩展角色未填 parent → 挂 Origin 下（兼容——视为初代分化）", () => {
    resetExtraRoles();
    registerWorkerRole({ id: "custom-x", labelPatterns: ["quantum-compute"], prompt: "测试角色" });
    const tree = buildRoleLineage();
    const custom = tree.children.find((c) => c.role.id === "custom-x");
    expect(custom).toBeTruthy();
    resetExtraRoles();
  });

  it("二代分化（子角色 parent=内置角色 → 挂对应子树）", () => {
    resetExtraRoles();
    registerWorkerRole({ id: "dev-frontend", labelPatterns: ["frontend-ui"], prompt: "前端专员", parent: "developer", generation: 2, differentiation: "前端任务诱导" });
    const tree = buildRoleLineage();
    const dev = tree.children.find((c) => c.role.id === "developer");
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
    expect(doc).toContain("谱系代数：1（父角色：origin）");
    expect(doc).toContain("实现类任务诱导");
    const originDoc = buildRoleDoc(ORIGIN_ROLE);
    expect(originDoc).toContain("谱系之根");
  });
});
