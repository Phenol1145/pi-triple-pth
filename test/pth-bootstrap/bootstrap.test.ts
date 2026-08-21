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

  it("P1：buildPthHost 返回 backends/routes；非法 PTH_EXEC_BACKENDS 监听前 fail-closed", async () => {
    const host = await buildPthHost(DEFAULT_MODULE_MANIFEST, {
      env: {
        PTH_EXEC_BACKENDS: JSON.stringify([
          { id: "local-lean", url: "http://host.docker.internal:8787", profile: "host" },
        ]),
        PTH_EXEC_BACKEND_ROUTES: JSON.stringify({ lean4: "local-lean" }),
        PTH_EXEC_SANDBOX_ALIAS: "off",
      },
    });
    expect(host.backends.get("local-lean")?.descriptor.url).toBe("http://host.docker.internal:8787");
    expect(host.routes).toEqual({ lean4: "local-lean" });
    expect(host.backends.get("sandbox")).toBeUndefined();

    await expect(buildPthHost(DEFAULT_MODULE_MANIFEST, {
      env: { PTH_EXEC_BACKENDS: "{broken", PTH_EXEC_SANDBOX_ALIAS: "off" },
    })).rejects.toThrow(/PTH_EXEC_BACKENDS 不是合法 JSON/);

    await expect(buildPthHost(DEFAULT_MODULE_MANIFEST, {
      env: {
        PTH_EXEC_BACKENDS: JSON.stringify([{ id: "x", url: "http://x", profile: "host", bogus: 1 }]),
        PTH_EXEC_SANDBOX_ALIAS: "off",
      },
    })).rejects.toThrow(/unknown backend descriptor field/);
  });

  it("T4：tool registry 注入合并为 engine backend（host.docker.internal 改写）", async () => {
    const host = await buildPthHost(DEFAULT_MODULE_MANIFEST, {
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      toolRegistry: {
        schemaVersion: 1,
        updatedAt: "",
        domainTokens: {},
        tools: {
          bf: {
            tool: "bf", domain: "compiled", backendId: "tools-compiled",
            url: "http://127.0.0.1:54321", port: 54321, token: "engine-token-tools-compiled", updatedAt: "",
          },
        },
      },
    });
    expect(host.backends.get("tools-compiled")?.descriptor).toMatchObject({
      id: "tools-compiled",
      url: "http://host.docker.internal:54321",
      profile: "dev-container",
    });
  });
});
