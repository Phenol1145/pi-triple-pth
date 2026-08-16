import { describe, expect, it } from "vitest";
import { CatalogBuilder } from "../../src/pth/catalog/catalog-builder.js";
import { validateCapabilityPolicy } from "../../src/pth/catalog/capability-policy.js";

function buildValid() {
  const builder = new CatalogBuilder();
  builder
    .addRole({ id: "developer", tags: ["code"], prompt: "dev" })
    .addRole({ id: "analyst", tags: ["analysis"], prompt: "analyst", capabilities: ["memory", "web"] })
    .addSpace({ id: "meta", parent: null, execTool: "ts", description: "元空间" })
    .addSpace({ id: "dev", parent: "meta", execTool: "python", description: "dev 空间" })
    .addExtension("agent-reach")
    .addExtension("jupyter-asm")
    .setCapabilityPolicy({ allow: ["memory.read", "memory.write", "web.fetchText"], deny: ["memory.write"] });
  return builder.build();
}

describe("catalog：RuntimeCatalogSnapshot + builder（P3-1）", () => {
  it("build 产出冻结快照：排序确定、同 manifest 构建一致", () => {
    const a = buildValid();
    const b = buildValid();
    expect(a.roleIds()).toEqual(["analyst", "developer"]);
    expect(a.spaceIds()).toEqual(["dev", "meta"]);
    expect(a.extensionIds()).toEqual(["agent-reach", "jupyter-asm"]);
    expect(a.toJSON()).toEqual(b.toJSON());
  });

  it("snapshot 冻结后不可变：返回副本，外部改动不影响内部", () => {
    const snap = buildValid();
    (snap.roles() as Array<{ id: string }>)[0]!.id = "hacked";
    (snap.spaces() as Array<{ id: string }>)[0]!.id = "hacked";
    (snap.extensions() as string[])[0] = "hacked";
    expect(snap.roleIds()).toContain("developer");
    expect(snap.spaceIds()).toContain("meta");
    expect(snap.extensionIds()).toContain("agent-reach");
  });

  it("builder build() 后拒绝修改", () => {
    const builder = new CatalogBuilder();
    builder.build();
    expect(() => builder.addRole({ id: "x", tags: ["x"], prompt: "x" })).toThrow(/sealed/);
    expect(() => builder.addSpace({ id: "x", parent: null, execTool: "ts" })).toThrow(/sealed/);
    expect(() => builder.setCapabilityPolicy({ allow: ["x"], deny: [] })).toThrow(/sealed/);
  });

  it("重复 id / 非法 capability / 非法 policy 一律 fail-closed", () => {
    const b1 = new CatalogBuilder().addRole({ id: "r", tags: ["r"], prompt: "r" });
    expect(() => b1.addRole({ id: "r", tags: ["r2"], prompt: "r2" })).toThrow(/duplicate/i);
    expect(() => b1.addSpace({ id: "s", parent: null, execTool: "ts" }).addSpace({ id: "s", parent: null, execTool: "ts" })).toThrow(/duplicate/i);

    const b2 = new CatalogBuilder();
    expect(() => b2.addRole({ id: "bad", tags: ["bad"], prompt: "bad", capabilities: ["../etc/passwd"] })).toThrow(/capability/i);
    expect(() => b2.addRole({ id: "", tags: [], prompt: "" })).toThrow(/id|prompt|tag/i);
  });

  it("capability-policy：重复/非法/deny 越界拒绝", () => {
    expect(validateCapabilityPolicy({ allow: ["memory.read"], deny: [] })).toMatchObject({ ok: true });
    expect(validateCapabilityPolicy({ allow: ["memory.read", "memory.read"], deny: [] }).ok).toBe(false);
    expect(validateCapabilityPolicy({ allow: ["bad cap!"], deny: [] }).ok).toBe(false);
    expect(validateCapabilityPolicy({ allow: ["memory.read"], deny: ["fs.write"] }).ok).toBe(false); // deny 必须在 allow 内
  });
});
