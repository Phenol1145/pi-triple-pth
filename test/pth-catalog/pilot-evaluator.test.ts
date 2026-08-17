/**
 * test/pth-catalog/pilot-evaluator.test.ts — N23 K5 + F4 评测器验收。
 *
 * F4 新增：
 *  - 生产 catalog（DISCIPLINE_DEFINITIONS + DisciplineCatalogBuilder）；
 *  - hardNegativePassRate / multiDomainResolution / distractorTop3Rate 指标；
 *  - fail-closed 负例：空 top5、空 evidence、缺 sourceId、source snapshot 漂移。
 */

import { describe, expect, it } from "vitest";
import { DisciplineCatalogBuilder } from "../../src/pth/catalog/discipline-catalog.js";
import { DISCIPLINE_DEFINITIONS } from "../../src/pth/catalog/data/discipline-catalog-data.js";
import { PILOT_EVAL_QUERIES, type PilotEvalQuery } from "../../src/pth/catalog/data/pilot-eval-queries.js";
import { PILOT_KNOWLEDGE, type PilotKnowledgeEntry } from "../../src/pth/catalog/data/pilot-knowledge.js";
import { PILOT_SOURCES, type PilotKnowledgeSource } from "../../src/pth/catalog/data/pilot-source-registry.js";
import { runPilotEval } from "../../src/pth/catalog/pilot-evaluator.js";

function buildCatalog() {
  const builder = new DisciplineCatalogBuilder();
  for (const def of DISCIPLINE_DEFINITIONS) builder.add(def);
  return builder.build();
}

function fullInput() {
  return {
    catalog: buildCatalog(),
    knowledge: PILOT_KNOWLEDGE,
    queries: PILOT_EVAL_QUERIES,
    sources: PILOT_SOURCES,
  };
}

describe("pilot-evaluator：离线全套指标与可解释性", () => {
  it("离线全套指标达到 F4 阈值（0.9 / 0.9 / 0.95 / 1.0 / 1.0 / 0.9）", () => {
    const metrics = runPilotEval(fullInput());
    expect(metrics.queryCount).toBe(84);
    expect(metrics.standardQueryCount).toBe(60);
    expect(metrics.domainRecallAt3).toBeGreaterThanOrEqual(0.9);
    expect(metrics.knowledgeRecallAt5).toBeGreaterThanOrEqual(0.9);
    expect(metrics.evidenceCoverage).toBeGreaterThanOrEqual(0.95);
    expect(metrics.hardNegativePassRate).toBe(1.0);
    expect(metrics.multiDomainResolution).toBe(1.0);
    expect(metrics.distractorTop3Rate).toBeGreaterThanOrEqual(0.9);
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

  it("fail-closed：authoritative 查询空 top-5 一律 fail", () => {
    const query: PilotEvalQuery = {
      id: "pl-fail-03",
      domain: "programming-languages",
      text: "no-answer-probe-empty-top5 不命中任何领域",
      authoritative: true,
      expectedEntryIds: ["pl-fact-type-checking"],
    };
    const metrics = runPilotEval({ ...fullInput(), queries: [query] });

    expect(metrics.evidenceCoverage).toBe(0);
    const detail = metrics.details[0]!;
    expect(detail.pass).toBe(false);
    expect(detail.reason).toContain("not in top5");
  });

  it("fail-closed：authoritative 查询计入条目空 evidence 一律 fail", () => {
    const entry: PilotKnowledgeEntry = {
      id: "pl-fact-empty-evidence",
      domain: "programming-languages",
      kind: "domain-fact",
      anchors: ["programming-languages", "computer-science", "formal-science", "类型检查"],
      content: "类型检查在编译期核对程序是否违反类型规则。",
      evidence: [],
    };
    const query: PilotEvalQuery = {
      id: "pl-fail-04",
      domain: "programming-languages",
      text: "编程语言中的类型检查发生在编译期还是运行期？",
      authoritative: true,
      expectedEntryIds: ["pl-fact-empty-evidence"],
    };
    const metrics = runPilotEval({ ...fullInput(), knowledge: [entry], queries: [query] });

    expect(metrics.evidenceCoverage).toBe(0);
    const detail = metrics.details[0]!;
    expect(detail.pass).toBe(false);
    expect(detail.reason).toContain("empty evidence");
  });

  it("fail-closed：source snapshot 漂移（artifactHash 与 snapshotContent 不一致）导致 evidence fail", () => {
    const corruptSource: PilotKnowledgeSource = {
      ...PILOT_SOURCES[0]!,
      artifactHash: "0".repeat(64),
    };
    const sources = PILOT_SOURCES.map((source) => (source.id === corruptSource.id ? corruptSource : source));
    const query = PILOT_EVAL_QUERIES.find((q) => q.id === "pl-01")!;
    const metrics = runPilotEval({ ...fullInput(), sources, queries: [query] });

    expect(metrics.evidenceCoverage).toBe(0);
    const detail = metrics.details[0]!;
    expect(detail.pass).toBe(false);
    expect(detail.reason).toContain("snapshot drift");
  });

  it("hard negative：expectNoKnowledge + 空 top-5 → pass，计入 hardNegativePassRate", () => {
    const query: PilotEvalQuery = {
      id: "pl-hn-test",
      domain: "programming-languages",
      text: "no-answer-probe-pl-01 该词条未收录于任何知识体系",
      authoritative: false,
      expectedEntryIds: [],
      expectNoKnowledge: true,
    };
    const metrics = runPilotEval({ ...fullInput(), queries: [query] });

    expect(metrics.hardNegativePassRate).toBe(1);
    expect(metrics.hardNegativeQueries).toBe(1);
    expect(metrics.details[0]!.pass).toBe(true);
  });

  it("multi-domain：expectedDomains 必须全部进入 resolver 前 3", () => {
    const query: PilotEvalQuery = {
      id: "pl-md-test",
      domain: "programming-languages",
      text: "使用编程语言处理 Materials Project 的晶体结构数据",
      authoritative: false,
      expectedEntryIds: [],
      expectedDomains: ["materials-science", "programming-languages"],
    };
    const metrics = runPilotEval({ ...fullInput(), queries: [query] });

    expect(metrics.multiDomainResolution).toBe(1);
    expect(metrics.multiDomainQueries).toBe(1);
    expect(metrics.details[0]!.pass).toBe(true);
  });

  it("distractor：目标域在 top3 或 primaryDomain=目标域 → distractorTop3Rate 命中", () => {
    const query: PilotEvalQuery = {
      id: "pl-ds-test",
      domain: "programming-languages",
      text: "计算机科学 与 编程语言 的类型检查有什么不同",
      authoritative: false,
      expectedEntryIds: [],
      distractorDomain: "computer-science",
    };
    const metrics = runPilotEval({ ...fullInput(), queries: [query] });

    expect(metrics.distractorTop3Rate).toBe(1);
    expect(metrics.distractorQueries).toBe(1);
    expect(metrics.details[0]!.pass).toBe(true);
  });
});
