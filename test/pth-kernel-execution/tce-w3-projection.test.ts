import { describe, it, expect } from "vitest";
import { PTC_CAPABILITIES, buildCapabilityAsActionMap } from "@away_from/pth-kernel-interpreter";
import { AGENT_CAPABILITY_AS_ACTION, AGENT_CAPABILITY_IDS } from "@away_from/pth-kernel-execution";

describe("TCE Wave 3 兼容投影", () => {
  it("legacy 名称在 AGENT_CAPABILITY_AS_ACTION 中可识别且只投影到 net.*", () => {
    expect(AGENT_CAPABILITY_IDS).toContain("web.get");
    expect(AGENT_CAPABILITY_IDS).toContain("reach.webSearch");
    expect(AGENT_CAPABILITY_IDS).toContain("reach.webRead");
    expect(AGENT_CAPABILITY_AS_ACTION["web.get"]!({ url: "https://example.com" })).toBe(
      'return await net.fetch({ schemaVersion: "net.fetch.request/v1", url: "https://example.com" });',
    );
    expect(AGENT_CAPABILITY_AS_ACTION["reach.webSearch"]!({ query: "pth", limit: 3 })).toBe(
      'return await net.search({ schemaVersion: "net.search.request/v1", query: "pth", limit: 3 });',
    );
    expect(AGENT_CAPABILITY_AS_ACTION["reach.webRead"]!({ url: "https://example.com" })).toContain(
      "await net.fetch({ schemaVersion: \"net.fetch.request/v1\", url: \"https://example.com\" })",
    );
    expect(AGENT_CAPABILITY_AS_ACTION["reach.webRead"]!({ url: "https://example.com" })).toContain(
      'artifactRef: f.artifact.ref',
    );
  });

  it("legacy projection 契约不进入 PTC_TOOL_DEFS（避免平行可见工具面）", async () => {
    const { PTC_TOOL_DEFS } = await import("@away_from/pth-kernel-interpreter");
    const names = PTC_TOOL_DEFS.map((d) => d.name);
    expect(names).not.toContain("web.get");
    expect(names).not.toContain("reach.webSearch");
    expect(names).not.toContain("reach.webRead");
  });

  it("PTC_CAPABILITIES 中 legacy projection 均带 asAction 且三要素齐全", () => {
    for (const id of ["web.get", "reach.webSearch", "reach.webRead"]) {
      const def = PTC_CAPABILITIES[id];
      expect(def).toBeTruthy();
      expect(def?.asAction).toBeTruthy();
      expect(def?.anchor.trim().length).toBeGreaterThan(0);
      expect(def?.whenToUse.trim().length).toBeGreaterThan(0);
      expect(def?.effect.trim().length).toBeGreaterThan(0);
    }
  });

  it("派生映射与注册表一致（单一真相源）", () => {
    const map = buildCapabilityAsActionMap();
    expect(map["web.get"]).toBe(AGENT_CAPABILITY_AS_ACTION["web.get"]);
    expect(map["reach.webSearch"]).toBe(AGENT_CAPABILITY_AS_ACTION["reach.webSearch"]);
    expect(map["reach.webRead"]).toBe(AGENT_CAPABILITY_AS_ACTION["reach.webRead"]);
  });
});
