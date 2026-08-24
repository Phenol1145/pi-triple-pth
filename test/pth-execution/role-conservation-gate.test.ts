import { describe, it, expect } from "vitest";
import { validateRoleRegistration, roleEffcap } from "../../src/pth/execution/role-conservation-gate.js";
import type { WorkerRole } from "@away_from/pth-kernel-execution";

const developer: WorkerRole = {
  id: "developer",
  tags: ["code"],
  prompt: "dev",
  capabilities: ["fs", "memory", "python", "bash", "c", "web", "obs"],
};

const roles: WorkerRole[] = [
  developer,
  { id: "coder", tags: ["code"], prompt: "coder", parent: "developer", capabilities: ["fs", "memory"] },
];

describe("W4 角色注册闸守恒校验", () => {
  it("produces 非法 → 拒绝", () => {
    const bad = validateRoleRegistration({ id: "x", tags: [], prompt: "x", parent: "developer", produces: [""] } as WorkerRole, roles);
    expect(bad).toContain("produces 非法");
  });

  it("L2：子能力不在父 effcap → 拒绝", () => {
    const bad = validateRoleRegistration({ id: "bad", tags: [], prompt: "x", parent: "developer", capabilities: ["manage"] } as WorkerRole, roles);
    expect(bad).toContain("L2 拒绝");
  });

  it("L2：子能力 ⊆ 父 effcap → 通过", () => {
    expect(validateRoleRegistration({ id: "good", tags: [], prompt: "x", parent: "developer", capabilities: ["fs", "memory"] } as WorkerRole, roles)).toBeNull();
  });

  it("roleEffcap 含父+全部后代能力", () => {
    const eff = roleEffcap(roles, "developer");
    expect(eff.has("fs")).toBe(true);
    expect(eff.has("memory")).toBe(true);
    expect(eff.has("manage")).toBe(false);
  });
});
