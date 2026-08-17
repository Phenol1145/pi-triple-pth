/**
 * test/pth-execution/knowledge-ranking.test.ts — F4 AB-07：query-sensitive ranking 纯函数验收。
 */

import { describe, expect, it } from "vitest";
import { rankKnowledgeEntries } from "../../src/pth/execution/knowledge-ranking.js";

interface Entry {
  id: string;
  anchors: string[];
  content: string;
}

describe("rankKnowledgeEntries（query-sensitive ranking）", () => {
  it("score = domainRelevance * 1000 + queryTokenHits；无 queryText 时 queryTokenHits=0", () => {
    const entries: Entry[] = [
      { id: "e1", anchors: ["math"], content: "quadratic formula" },
      { id: "e2", anchors: ["math", "algebra"], content: "quadratic formula" },
      { id: "e3", anchors: ["geometry"], content: "triangle area" },
    ];

    const ranked = rankKnowledgeEntries(entries, { domains: ["algebra"], domainAncestors: ["algebra", "math"] });
    // e2 domainRelevance=2（algebra+math）；e1=1（algebra）；e3=0 → score 2000/1000/0
    expect(ranked.map((e) => e.id)).toEqual(["e2", "e1", "e3"]);
  });

  it("queryText 空白分词后对 content+anchors 大小写不敏感子串命中数作为 tie-break", () => {
    const entries: Entry[] = [
      { id: "b1", anchors: ["math"], content: "Quadratic Formula" },
      { id: "a1", anchors: ["math"], content: "Completing the square" },
      { id: "c1", anchors: ["math"], content: "Factor by grouping" },
    ];

    const ranked = rankKnowledgeEntries(entries, { domains: ["math"], queryText: "FORMULA quadratic" });
    // b1 token hits: formula + quadratic = 2 → score 1002；其余 1000；降序后 a1/c1 按 id 升序
    expect(ranked.map((e) => e.id)).toEqual(["b1", "a1", "c1"]);
  });

  it("降序 score → id 升序 tie-break", () => {
    const entries: Entry[] = [
      { id: "z", anchors: ["math"], content: "x" },
      { id: "a", anchors: ["math"], content: "x" },
      { id: "m", anchors: ["math", "algebra"], content: "x" },
    ];

    const ranked = rankKnowledgeEntries(entries, { domains: ["math"], domainAncestors: ["algebra"] });
    expect(ranked.map((e) => e.id)).toEqual(["m", "a", "z"]);
  });

  it("domainAncestors 参与命中面：祖先锚点也算 domainRelevance", () => {
    const entries: Entry[] = [
      { id: "core", anchors: ["algebra", "math"], content: "x" },
      { id: "leaf", anchors: ["algebra"], content: "x" },
    ];

    const ranked = rankKnowledgeEntries(entries, { domains: ["algebra"], domainAncestors: ["algebra", "math"] });
    expect(ranked.map((e) => e.id)).toEqual(["core", "leaf"]);
  });

  it("不修改原数组（返回新数组）", () => {
    const entries: Entry[] = [{ id: "a", anchors: ["math"], content: "x" }];
    const ranked = rankKnowledgeEntries(entries, { domains: ["math"] });
    expect(ranked).not.toBe(entries);
    expect(entries).toHaveLength(1);
  });
});
