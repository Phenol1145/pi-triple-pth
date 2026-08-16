import { describe, expect, it } from "vitest";
import { buildPthHost } from "../../src/pth/bootstrap/pth-host.js";
import { DEFAULT_MODULE_MANIFEST, validateModuleManifest } from "../../src/pth/bootstrap/module-manifest.js";
import { getRuntimeCatalog } from "../../src/pth/catalog/role-routing-policy.js";

describe("P3-4：bootstrap 统一装配入口", () => {
  it("manifest：未知 module / 非法 catalog fail-closed", () => {
    expect(validateModuleManifest({ modules: ["kernel", "nope"], catalog: "builtin", strictExtensionContributions: true }).ok).toBe(false);
    expect(validateModuleManifest({ modules: ["kernel"], catalog: "remote", strictExtensionContributions: true }).ok).toBe(false);
    expect(validateModuleManifest(DEFAULT_MODULE_MANIFEST).ok).toBe(true);
  });

  it("buildPthHost 构建 catalog 并注入运行时（main 与 batch-process 共用）", async () => {
    const a = await buildPthHost(DEFAULT_MODULE_MANIFEST);
    const b = await buildPthHost(DEFAULT_MODULE_MANIFEST);
    expect(a.catalog.toJSON()).toEqual(b.catalog.toJSON());
    expect(getRuntimeCatalog()).toBe(b.catalog);
  });

  it("非法 manifest 在 buildPthHost 阶段抛错（监听前 fail-closed）", async () => {
    await expect(buildPthHost({ modules: ["ghost"], catalog: "builtin", strictExtensionContributions: true })).rejects.toThrow(/fail-closed/);
  });

  it("不引入 PTH_PROFILE 产品选择", () => {
    expect("profile" in DEFAULT_MODULE_MANIFEST).toBe(false);
    expect(DEFAULT_MODULE_MANIFEST.modules).toContain("kernel");
  });
});
