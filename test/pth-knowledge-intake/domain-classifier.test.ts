import { describe, it, expect } from "vitest";
import { classifyDomain } from "../../src/pth/execution/knowledge-intake/domain-classifier.js";

describe("N26 多域分类", () => {
  it("code/research/operations/general", () => {
    expect(classifyDomain("typescript api design")).toBe("code");
    expect(classifyDomain("research paper survey")).toBe("research");
    expect(classifyDomain("deploy runbook incident")).toBe("operations");
    expect(classifyDomain("hello world")).toBe("general");
  });
});
