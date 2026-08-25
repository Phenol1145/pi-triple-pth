import { describe, it, expect } from "vitest";
import { shouldPromoteToTrusted, expandCandidates } from "../../src/pth/execution/knowledge-intake/auto-expansion.js";

describe("N26 自动扩源", () => {
  it("达到阈值晋升 trusted", () => {
    expect(shouldPromoteToTrusted(3)).toBe(true);
    expect(shouldPromoteToTrusted(2)).toBe(false);
  });

  it("种子 + 发现并集去重", () => {
    expect(expandCandidates(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });
});
