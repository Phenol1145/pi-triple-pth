import { describe, it, expect } from "vitest";
import { SourceDiscovery } from "../../src/pth/execution/knowledge-intake/source-discovery.js";

describe("N26 来源发现外环", () => {
  it("register/list 来源注册表", () => {
    const sd = new SourceDiscovery();
    sd.register({ id: "s1", url: "https://example.com", kind: "web", trust: "seed", enabled: true });
    expect(sd.list()).toHaveLength(1);
  });

  it("discoverCandidates 从种子 URL 生成候选", () => {
    const sd = new SourceDiscovery();
    const candidates = sd.discoverCandidates(["https://a.com", "https://b.com"]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.trust).toBe("candidate");
  });
});
