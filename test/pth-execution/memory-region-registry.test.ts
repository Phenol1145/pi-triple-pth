import { describe, it, expect } from "vitest";
import { MemoryRegionRegistry } from "../../src/pth/execution/memory-region-registry.js";

describe("N28 MemoryRegion Registry", () => {
  it("register/list/addMember/membersOf", () => {
    const reg = new MemoryRegionRegistry();
    reg.register({ id: "r1", tenantId: "t", selector: { kind: "skill" }, ownerRoleId: "memory-keeper", weight: 80 });
    expect(reg.list("t")).toHaveLength(1);
    expect(reg.addMember("r1", "entry-1")).toBe(true);
    expect(reg.membersOf("r1")).toEqual(["entry-1"]);
  });

  it("不存在的 region addMember 返回 false", () => {
    const reg = new MemoryRegionRegistry();
    expect(reg.addMember("nope", "e")).toBe(false);
  });
});
