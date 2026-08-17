/**
 * test/pth-catalog/pilot-evaluator.test.ts — N23 K5 评测批：评测器验收。
 */

import { describe, expect, it } from "vitest";
import { buildPilotCatalog } from "../../src/pth/catalog/data/pilot-domain-overrides.js";
import { PILOT_EVAL_QUERIES, type PilotEvalQuery } from "../../src/pth/catalog/data/pilot-eval-queries.js";
import { PILOT_KNOWLEDGE, type PilotKnowledgeEntry } from "../../src/pth/catalog/data/pilot-knowledge.js";
import { PILOT_SOURCES } from "../../src/pth/catalog/data/pilot-source-registry.js";
import { runPilotEval } from "../../src/pth/catalog/pilot-evaluator.js";

function fullInput() {
  return {
    catalog: buildPilotCatalog(),
    knowledge: PILOT_KNOWLEDGE,
    queries: PILOT_EVAL_QUERIES,
    sources: PILOT_SOURCES,
  };
}

describe("pilot-evaluator：离线全套指标与可解释性", () => {
  it("离线全套指标达到 N23 阈值（0.9 / 0.9 / 0.95）", () => {
    const metrics = runPilotEval(fullInput());
    expect(metrics.queryCount).toBe(60);
    expect(metrics.domainRecallAt3).toBeGreaterThanOrEqual(0.9);
    expect(metrics.knowledgeRecallAt5).toBeGreaterThanOrEqual(0.9);
    expect(metrics.evidenceCoverage).toBeGreaterThanOrEqual(0.95);
    expect(metrics.details.filter((detail) => !detail.pass)).toEqual([]);
  });

  it("同输入同输出：两次 run 指标与明细完全一致（确定性）", () => {
    const first = runPilotEval(fullInput());
    const second = runPilotEval(fullInput());
    expect(second).toEqual(first);
  });

  it("失败用例可解释：未命中 domain 与未命中 top5 均给出 reason", () => {
    const query: PilotEvalQuery = {
      id: "pl-fail-01",
      domain: "programming-languages",
      text: "这个句子不包含任何领域别名",
      authoritative: false,
      expectedEntryIds: ["pl-fact-type-system"],
    };
    const metrics = runPilotEval({ ...fullInput(), queries: [query] });

    expect(metrics.domainRecallAt3).toBe(0);
    expect(metrics.knowledgeRecallAt5).toBe(0);
    const detail = metrics.details[0]!;
    expect(detail.pass).toBe(false);
    expect(detail.reason).toContain("expected domain programming-languages not in top3");
    expect(detail.reason).toContain("not in top5");
  });

  it("失败用例可解释：authoritative 查询 evidence.sourceId 缺失会点名来源", () => {
    const entry: PilotKnowledgeEntry = {
      id: "pl-fact-bad-evidence",
      domain: "programming-languages",
      kind: "domain-fact",
      anchors: ["programming-languages", "类型检查"],
      content: "类型检查在编译期核对程序是否违反类型规则。",
      evidence: [{ sourceId: "missing-source", locator: "x" }],
    };
    const query: PilotEvalQuery = {
      id: "pl-fail-02",
      domain: "programming-languages",
      text: "编程语言中的类型检查发生在编译期还是运行期？",
      authoritative: true,
      expectedEntryIds: ["pl-fact-bad-evidence"],
    };
    const metrics = runPilotEval({ ...fullInput(), knowledge: [entry], queries: [query] });

    expect(metrics.evidenceCoverage).toBe(0);
    const detail = metrics.details[0]!;
    expect(detail.pass).toBe(false);
    expect(detail.reason).toContain("evidence sourceId missing from sources: pl-fact-bad-evidence:missing-source");
  });
});
