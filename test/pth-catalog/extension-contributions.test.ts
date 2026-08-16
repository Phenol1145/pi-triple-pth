import { describe, expect, it } from "vitest";
import { validateCatalogContributions } from "../../src/pth/catalog/extensions/contribution-schema.js";
import { classifyExtensionDir } from "../../src/pth/catalog/extensions/extension-policy.js";
import { loadCatalogContributions } from "../../src/pth/catalog/extensions/extension-loader.js";

describe("P3-3：扩展贡献显式化", () => {
  it("catalog 只接受有宿主实现的贡献：tools/events/kernels/debugAdapters/onStartup 拒绝", () => {
    const bad = validateCatalogContributions({ tools: ["greet"], events: ["task.claim"] });
    expect(bad.ok).toBe(false);
    expect(bad.unsupported).toContain("tools");
    expect(bad.unsupported).toContain("events");

    const ok = validateCatalogContributions({
      roles: [{ id: "r", tags: ["r"], prompt: "p" }],
      spaces: [{ id: "s", parent: "meta" }],
      observers: { audit: true },
      capabilityPolicies: { allow: ["memory.read"], deny: [] },
    });
    expect(ok.ok).toBe(true);
  });

  it("loader 只装载宿主实现存在的贡献", () => {
    const r = loadCatalogContributions(
      { roles: [{ id: "r", tags: ["r"], prompt: "p" }] },
      { roles: [{ id: "r", tags: ["r"], prompt: "p" }] },
      { extensionId: "x", hasRoles: true, hasSpaces: false, hasObservers: false, hasCapabilityPolicies: false },
    );
    expect(r.ok).toBe(true);
    expect(r.contributions?.roles).toHaveLength(1);

    const reject = loadCatalogContributions({ tools: ["x"] }, {}, {
      extensionId: "legacy", hasRoles: false, hasSpaces: false, hasObservers: false, hasCapabilityPolicies: false,
    });
    expect(reject.ok).toBe(false);
    expect(reject.error).toContain("tools");
  });

  it("目录分类：PTH 插件 / 外来目录 / 坏插件", () => {
    expect(classifyExtensionDir({ hasPluginJson: false }).class).toBe("external-dir");
    expect(classifyExtensionDir({ hasPluginJson: true, manifestError: "bad json" }).class).toBe("bad-plugin");
    expect(classifyExtensionDir({ hasPluginJson: true, manifest: { contracts: { tools: ["greet"] } } }).class).toBe("pth-plugin");
  });
});
