import { describe, it, expect } from "vitest";
import { loadDefaultRoleCards } from "../../src/pth/catalog/role-catalog-loader.js";
import { DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES } from "@away_from/pth-kernel-execution";
import { PROFESSIONAL_ROLES } from "@away_from/pth-kernel-execution";

describe("Role Catalog W1 目录装载器", () => {
  it("默认目录 42 张卡片全部校验通过并投影", () => {
    const result = loadDefaultRoleCards();
    expect(result.errors).toEqual([]);
    expect(result.roles).toHaveLength(42);
    const ids = new Set(result.roles.map((r) => r.id));
    expect(ids.has("sensor:worker-opt")).toBe(true);
    expect(ids.has("controller:adversarial")).toBe(true);
    expect(ids.has("coder")).toBe(true);
    expect(ids.has("actuator")).toBe(true);
  });

  it("每张卡片 projection 保留 id/parent/capabilities/actionTools", () => {
    const result = loadDefaultRoleCards();
    for (const role of result.roles) {
      expect(role.id).toBeTruthy();
      expect(Array.isArray(role.tags)).toBe(true);
      expect(typeof role.prompt).toBe("string");
      expect(Array.isArray(role.capabilities)).toBe(true);
      expect(Array.isArray(role.actionTools)).toBe(true);
    }
  });

  it("与内置 bundle 等价（42 张卡片零行为变化）", () => {
    const result = loadDefaultRoleCards();
    const builtin = [...DEFAULT_ROLES, ...MID_ROLES, ...GOVERNANCE_ROLES, ...PROFESSIONAL_ROLES];
    expect(result.roles.map((r) => r.id).sort()).toEqual(builtin.map((r) => r.id).sort());
    for (const b of builtin) {
      const c = result.roles.find((r) => r.id === b.id)!;
      expect(c.tags).toEqual(b.tags);
      expect(c.prompt).toBe(b.prompt);
      expect(c.capabilities ?? []).toEqual(b.capabilities ?? []);
      expect(c.actionTools ?? []).toEqual(b.actionTools ?? []);
      expect(c.parent ?? null).toBe(b.parent ?? null);
      expect(c.thinking ?? null).toBe(b.thinking ?? null);
      expect(c.model ?? null).toBe(b.model ?? null);
      expect(c.memoryScope ?? null).toBe(b.memoryScope ?? null);
      expect(c.produces ? [...c.produces] : []).toEqual(b.produces ? [...b.produces] : []);
      expect(c.defaultReads ?? []).toEqual(b.defaultReads ?? []);
    }
  });
});
