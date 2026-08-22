import { describe, expect, it } from "vitest";
import { buildBuiltinCatalog } from "../../src/pth/catalog/adapters/builtin-catalog-contributions.js";
import { createRoleRoutingPolicy, setRuntimeCatalog } from "../../src/pth/catalog/role-routing-policy.js";
import { createSpaceLookup } from "../../src/pth/catalog/space-lookup.js";
import { BUILTIN_SPACE_DEFS } from "../../src/pth/impls/spaces/builtin-spaces.js";
import { ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES } from "../../src/pth/impls/roles/default-roles.js";
import { PROFESSIONAL_ROLES } from "@away_from/pth-kernel-execution";
import { installDefaultRoles } from "../helpers";

installDefaultRoles();

describe("P3-2：catalog 注入等价性", () => {
  it("同一 manifest 构建等价 catalog（assembly/batch-process 共用）", () => {
    const a = buildBuiltinCatalog();
    const b = buildBuiltinCatalog();
    expect(a.toJSON()).toEqual(b.toJSON());
  });

  it("catalog 角色键与内置角色全量一致", () => {
    const catalog = buildBuiltinCatalog();
    const expected = [ORIGIN_ROLE, ...DEFAULT_ROLES, ...MID_ROLES, ...GOVERNANCE_ROLES, ...PROFESSIONAL_ROLES].map((r) => r.id);
    expect(new Set(catalog.roleIds())).toEqual(new Set(expected));
  });

  it("catalog 空间键与内置空间定义一致", () => {
    const catalog = buildBuiltinCatalog();
    expect(new Set(catalog.spaceIds())).toEqual(new Set(BUILTIN_SPACE_DEFS.map((s) => s.id)));
  });

  it("RoleRoutingPolicy 只读快照：已知标签路由、未知拒绝、flow 显式优先", () => {
    const policy = createRoleRoutingPolicy(buildBuiltinCatalog());
    expect(policy.validate(["code"])).toEqual({ ok: true });
    expect(policy.validate(["totally-unknown-tag"]).ok).toBe(false);
    expect(policy.routeRole(["code"]).role).toBe("developer");
    expect(policy.flowRole({ flow: { stages: [{ task: { role: "analyst" } }] } })).toBe("analyst");
  });

  it("SpaceLookup 只读快照：get/children/depth", () => {
    const lookup = createSpaceLookup(buildBuiltinCatalog());
    expect(lookup.get("meta")?.parent).toBeNull();
    expect(lookup.get("dev")?.parent).toBe("meta");
    expect(lookup.childrenOf("meta").map((s) => s.id)).toContain("dev");
    expect(lookup.depthOf("dev")).toBe(1);
  });

  it("注入快照后 role-router 走 catalog 路径（新生产代码不再依赖全局 getter 语义）", async () => {
    setRuntimeCatalog(buildBuiltinCatalog());
    const { checkTaskRouting } = await import("@away_from/pth-kernel-execution");
    expect(checkTaskRouting({ tags: ["code"] })).toEqual({ ok: true });
    expect(checkTaskRouting({ tags: ["totally-unknown-tag"] }).ok).toBe(false);
  });
});
