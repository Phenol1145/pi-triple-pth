/**
 * test/pth-catalog/discipline-resolver.test.ts — K2 Discipline Resolver 契约测试。
 *
 * 覆盖：显式单域/多域去重、未知显式 id fail-closed、别名命中（zh/alias）、
 * 无命中空 domains、primaryDomain、binding 通过 validate、resolverVersion/catalogVersion。
 */

import { describe, expect, it } from "vitest";
import { DisciplineCatalogBuilder } from "../../src/pth/catalog/discipline-catalog.js";
import { createDisciplineResolver } from "../../src/pth/catalog/discipline-resolver.js";
import { validateDomainBinding } from "@away_from/pth-contracts";

function buildCatalog() {
  return new DisciplineCatalogBuilder()
    .add({
      id: "mathematics",
      names: { "zh-CN": "数学：代数/几何/分析", en: "mathematics" },
      aliases: ["math", "maths"],
      parents: [],
      level: "category",
      description: "数学",
      methodAnchors: [],
      sourceRegistryIds: [],
      toolAnchors: [],
    })
    .add({
      id: "statistics",
      names: { "zh-CN": "统计学：概率/推断/回归", en: "statistics" },
      aliases: ["stats"],
      parents: ["mathematics"],
      level: "discipline",
      description: "统计学",
      methodAnchors: [],
      sourceRegistryIds: [],
      toolAnchors: [],
    })
    .add({
      id: "biology",
      names: { "zh-CN": "生物学：细胞/遗传/生态", en: "biology" },
      aliases: ["bio"],
      parents: [],
      level: "category",
      description: "生物学",
      methodAnchors: [],
      sourceRegistryIds: [],
      toolAnchors: [],
    })
    .build();
}

describe("createDisciplineResolver：显式 domains", () => {
  it("单域：去重校验后 confidence=1，evidence=explicit:<id>", () => {
    const catalog = buildCatalog();
    const resolver = createDisciplineResolver(catalog);

    const result = resolver.resolve({
      title: "t",
      text: "x",
      tags: [],
      explicitDomains: ["statistics"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.matches).toEqual([
      { domainId: "statistics", confidence: 1, evidence: ["explicit:statistics"] },
    ]);
    expect(result.binding.primaryDomain).toBe("statistics");
    expect(result.binding.catalogVersion).toBe(catalog.version);
    expect(result.binding.resolverVersion).toBe("v1-explicit-alias");
    expect(validateDomainBinding(result.binding, catalog.ids())).toEqual({ ok: true });
  });

  it("多域：按 id 排序去重", () => {
    const catalog = buildCatalog();
    const resolver = createDisciplineResolver(catalog);

    const result = resolver.resolve({
      title: "t",
      text: "x",
      tags: [],
      explicitDomains: ["biology", "statistics", "biology", "mathematics"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.matches.map((m) => m.domainId)).toEqual([
      "biology",
      "mathematics",
      "statistics",
    ]);
    expect(result.binding.primaryDomain).toBe("biology");
    for (const m of result.binding.matches) {
      expect(m.confidence).toBe(1);
      expect(m.evidence).toEqual([`explicit:${m.domainId}`]);
    }
  });

  it("未知显式 id fail-closed", () => {
    const catalog = buildCatalog();
    const resolver = createDisciplineResolver(catalog);

    const result = resolver.resolve({
      title: "t",
      text: "x",
      tags: [],
      explicitDomains: ["astrology"],
    });

    expect(result).toEqual({ ok: false, error: expect.stringContaining("astrology") });
  });
});

describe("createDisciplineResolver：别名扫描", () => {
  it("zh-CN 名称子串命中，confidence=0.6，evidence=text:<name>", () => {
    const catalog = buildCatalog();
    const resolver = createDisciplineResolver(catalog);

    const result = resolver.resolve({
      title: "数学建模",
      text: "参考数学：代数/几何/分析 完成问题",
      tags: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.matches).toEqual([
      { domainId: "mathematics", confidence: 0.6, evidence: ["text:数学：代数/几何/分析"] },
    ]);
    expect(result.binding.primaryDomain).toBe("mathematics");
    expect(result.binding.resolverVersion).toBe("v1-explicit-alias");
  });

  it("alias 子串命中（大小写不敏感）", () => {
    const catalog = buildCatalog();
    const resolver = createDisciplineResolver(catalog);

    const result = resolver.resolve({
      title: "BIO 作业",
      text: "cell biology and genetics",
      tags: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.matches).toEqual([
      { domainId: "biology", confidence: 0.6, evidence: ["text:bio"] },
    ]);
  });

  it("按 id 排序取前 5", () => {
    const catalog = new DisciplineCatalogBuilder()
      .add({ id: "d-a", names: { "zh-CN": "x" }, aliases: [], parents: [], level: "category", description: "d", methodAnchors: [], sourceRegistryIds: [], toolAnchors: [] })
      .add({ id: "d-b", names: { "zh-CN": "x" }, aliases: [], parents: [], level: "category", description: "d", methodAnchors: [], sourceRegistryIds: [], toolAnchors: [] })
      .add({ id: "d-c", names: { "zh-CN": "x" }, aliases: [], parents: [], level: "category", description: "d", methodAnchors: [], sourceRegistryIds: [], toolAnchors: [] })
      .add({ id: "d-d", names: { "zh-CN": "x" }, aliases: [], parents: [], level: "category", description: "d", methodAnchors: [], sourceRegistryIds: [], toolAnchors: [] })
      .add({ id: "d-e", names: { "zh-CN": "x" }, aliases: [], parents: [], level: "category", description: "d", methodAnchors: [], sourceRegistryIds: [], toolAnchors: [] })
      .add({ id: "d-f", names: { "zh-CN": "x" }, aliases: [], parents: [], level: "category", description: "d", methodAnchors: [], sourceRegistryIds: [], toolAnchors: [] })
      .build();
    const resolver = createDisciplineResolver(catalog);

    const result = resolver.resolve({ title: "x", text: "", tags: [] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.matches.map((m) => m.domainId)).toEqual(["d-a", "d-b", "d-c", "d-d", "d-e"]);
  });

  it("无命中 → 空 domains 且 primaryDomain 缺失", () => {
    const catalog = buildCatalog();
    const resolver = createDisciplineResolver(catalog);

    const result = resolver.resolve({ title: "写周报", text: "记录进展", tags: [] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.matches).toEqual([]);
    expect(result.binding.primaryDomain).toBeUndefined();
    expect(validateDomainBinding(result.binding, catalog.ids())).toEqual({ ok: true });
  });

  it("显式 domains 优先于文本扫描", () => {
    const catalog = buildCatalog();
    const resolver = createDisciplineResolver(catalog);

    const result = resolver.resolve({
      title: "生物统计",
      text: "用 stats 方法分析细胞",
      tags: [],
      explicitDomains: ["mathematics"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.matches.map((m) => m.domainId)).toEqual(["mathematics"]);
    expect(result.binding.matches[0]!.confidence).toBe(1);
  });
});
