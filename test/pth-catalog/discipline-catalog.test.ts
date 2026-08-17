/**
 * test/pth-catalog/discipline-catalog.test.ts — K0 Discipline Catalog 契约测试。
 *
 * 覆盖：重复 id / 缺父 / 环 / 多父通过 / ancestors / descendants /
 * resolveAlias（歧义拒绝）/ counts / version 确定性。
 */

import { describe, expect, it } from "vitest";
import {
  DisciplineCatalogBuilder,
  DisciplineCatalogSnapshot,
} from "../../src/pth/catalog/discipline-catalog.js";
import {
  DOMAIN_ID_RE,
  validateDomainBinding,
  validateDomainDefinition,
  type DomainDefinition,
} from "../../src/pth/contracts/domains.js";

let seq = 0;

function makeDef(overrides: Partial<DomainDefinition> = {}): DomainDefinition {
  const id = overrides.id ?? `node-${++seq}`;
  return {
    id,
    names: { "zh-CN": id },
    aliases: [],
    parents: [],
    level: "discipline",
    description: "测试节点",
    methodAnchors: [],
    sourceRegistryIds: [],
    toolAnchors: [],
    ...overrides,
  };
}

function buildSampleDag(): DisciplineCatalogSnapshot {
  return new DisciplineCatalogBuilder()
    .add(makeDef({ id: "c", level: "category" }))
    .add(makeDef({ id: "d1", parents: ["c"] }))
    .add(makeDef({ id: "d2", parents: ["c"] }))
    .add(makeDef({ id: "s1", parents: ["d1"], level: "sub-discipline" }))
    .add(makeDef({ id: "s2", parents: ["d1", "d2"], level: "sub-discipline" }))
    .build();
}

describe("DisciplineCatalog：builder fail-closed", () => {
  it("重复 id 在 add() 抛错", () => {
    const builder = new DisciplineCatalogBuilder().add(makeDef({ id: "dup" }));
    expect(() => builder.add(makeDef({ id: "dup" }))).toThrow(/duplicate|重复/i);
  });

  it("非法 definition 在 add() 抛错", () => {
    const builder = new DisciplineCatalogBuilder();
    expect(() => builder.add(makeDef({ id: "Bad ID" }))).toThrow(/invalid|非法/i);
    expect(() => builder.add(makeDef({ description: "   " }))).toThrow(/description|invalid/i);
  });

  it("缺父在 build() fail-closed", () => {
    const builder = new DisciplineCatalogBuilder()
      .add(makeDef({ id: "child", parents: ["ghost"] }));
    expect(() => builder.build()).toThrow(/ghost/);
  });

  it("多父 DAG 无环检测：环上节点名进错误信息", () => {
    const builder = new DisciplineCatalogBuilder()
      .add(makeDef({ id: "a", parents: ["b"] }))
      .add(makeDef({ id: "b", parents: ["c"] }))
      .add(makeDef({ id: "c", parents: ["a"] }));
    expect(() => builder.build()).toThrow(/cycle|环/i);
    expect(() => builder.build()).toThrow(/a/);
    expect(() => builder.build()).toThrow(/b/);
    expect(() => builder.build()).toThrow(/c/);
  });

  it("build() 后 builder sealed", () => {
    const builder = new DisciplineCatalogBuilder().add(makeDef({ id: "x" }));
    builder.build();
    expect(() => builder.add(makeDef({ id: "y" }))).toThrow(/sealed/);
  });
});

describe("DisciplineCatalog：snapshot 导航", () => {
  it("多父通过：ancestors 含自身，按深度稳定序", () => {
    const snap = buildSampleDag();
    expect(snap.ancestors("s2")).toEqual(["s2", "d1", "d2", "c"]);
    expect(snap.ancestors("c")).toEqual(["c"]);
  });

  it("descendants 不含自身，按深度稳定序", () => {
    const snap = buildSampleDag();
    expect(snap.descendants("c")).toEqual(["d1", "d2", "s1", "s2"]);
    expect(snap.descendants("d1")).toEqual(["s1", "s2"]);
    expect(snap.descendants("s1")).toEqual([]);
  });

  it("get / list：按 id 排序且返回副本", () => {
    const snap = buildSampleDag();
    expect(snap.list().map((d) => d.id)).toEqual(["c", "d1", "d2", "s1", "s2"]);
    expect(snap.get("s2")?.parents).toEqual(["d1", "d2"]);
    expect(snap.get("nope")).toBeUndefined();

    const list = snap.list();
    list[0]!.id = "hacked";
    expect(snap.get("c")?.id).toBe("c");
  });

  it("resolveAlias：先 id 后 aliases；歧义与未知 fail-closed", () => {
    const snap = new DisciplineCatalogBuilder()
      .add(makeDef({ id: "cat", aliases: ["catalog"], level: "category" }))
      .add(makeDef({ id: "d1", aliases: ["same"] }))
      .add(makeDef({ id: "d2", aliases: ["same", "d1"] }))
      .build();

    expect(snap.resolveAlias("cat").id).toBe("cat");
    expect(snap.resolveAlias("catalog").id).toBe("cat");
    // id 优先：即使 “d1” 是 d2 的 alias，也命中 id=d1
    expect(snap.resolveAlias("d1").id).toBe("d1");
    // 歧义拒绝
    expect(() => snap.resolveAlias("same")).toThrow(/ambiguous|歧义|multiple/i);
    // 未知拒绝
    expect(() => snap.resolveAlias("nope")).toThrow(/unknown|未知|not found/i);
  });

  it("counts：category/discipline/subDiscipline/total", () => {
    const snap = buildSampleDag();
    expect(snap.counts()).toEqual({ category: 1, discipline: 2, subDiscipline: 2, total: 5 });
  });

  it("version 确定性：add 顺序无关，数据变化版本变化", () => {
    const defs = [
      makeDef({ id: "c", level: "category" }),
      makeDef({ id: "d1", parents: ["c"] }),
      makeDef({ id: "d2", parents: ["c"] }),
      makeDef({ id: "s1", parents: ["d1"], level: "sub-discipline" }),
    ];
    const forward = new DisciplineCatalogBuilder();
    for (const d of defs) forward.add(d);
    const backward = new DisciplineCatalogBuilder();
    for (const d of [...defs].reverse()) backward.add(d);

    const forwardSnap = forward.build();
    const backwardSnap = backward.build();
    expect(forwardSnap.version).toBe(backwardSnap.version);

    const changed = new DisciplineCatalogBuilder();
    for (const d of defs) changed.add(d.id === "s1" ? { ...d, names: { "zh-CN": "改名" } } : d);
    expect(changed.build().version).not.toBe(forwardSnap.version);
  });
});

describe("contracts/domains：结构校验", () => {
  it("validateDomainDefinition：正则/level/names/description/数组形状", () => {
    expect(validateDomainDefinition(makeDef({ id: "ok-id" }))).toEqual({ ok: true });
    expect(validateDomainDefinition(makeDef({ id: "Bad" })).ok).toBe(false);
    expect(validateDomainDefinition(makeDef({ id: "ok", level: "gen-3" as never })).ok).toBe(false);
    expect(validateDomainDefinition(makeDef({ id: "ok", names: {} })).ok).toBe(false);
    expect(validateDomainDefinition(makeDef({ id: "ok", names: { "zh-CN": "" } })).ok).toBe(false);
    expect(validateDomainDefinition(makeDef({ id: "ok", description: "" })).ok).toBe(false);
    expect(validateDomainDefinition(makeDef({ id: "ok", aliases: [1] as never })).ok).toBe(false);
    expect(validateDomainDefinition(makeDef({ id: "ok", parents: ["bad id"] })).ok).toBe(false);
    expect(validateDomainDefinition(makeDef({ id: "ok", parents: ["a", "a"] })).ok).toBe(false);
  });

  it("DOMAIN_ID_RE 只接受小写 id 风格", () => {
    expect(DOMAIN_ID_RE.test("formal-science")).toBe(true);
    expect(DOMAIN_ID_RE.test("a")).toBe(true);
    expect(DOMAIN_ID_RE.test("A")).toBe(false);
    expect(DOMAIN_ID_RE.test("-a")).toBe(false);
    expect(DOMAIN_ID_RE.test("a_b")).toBe(false);
  });

  it("validateDomainBinding：matches 可为空；primaryDomain 必须在 matches 中", () => {
    const known = new Set(["d1", "d2"]);
    expect(validateDomainBinding({
      matches: [],
      catalogVersion: "v1",
      resolverVersion: "r1",
    }, known)).toEqual({ ok: true });

    expect(validateDomainBinding({
      matches: [{ domainId: "d1", confidence: 0.8, evidence: ["e"] }],
      primaryDomain: "d1",
      catalogVersion: "v1",
      resolverVersion: "r1",
    }, known)).toEqual({ ok: true });

    expect(validateDomainBinding({
      matches: [{ domainId: "ghost", confidence: 0.8, evidence: [] }],
      catalogVersion: "v1",
      resolverVersion: "r1",
    }, known).ok).toBe(false);

    expect(validateDomainBinding({
      matches: [{ domainId: "d1", confidence: 1.2, evidence: [] }],
      catalogVersion: "v1",
      resolverVersion: "r1",
    }, known).ok).toBe(false);

    expect(validateDomainBinding({
      matches: [{ domainId: "d1", confidence: 0.5, evidence: [] }],
      primaryDomain: "d2",
      catalogVersion: "v1",
      resolverVersion: "r1",
    }, known).ok).toBe(false);

    expect(validateDomainBinding({
      matches: [
        { domainId: "d1", confidence: 0.5, evidence: [] },
        { domainId: "d1", confidence: 0.6, evidence: [] },
      ],
      catalogVersion: "v1",
      resolverVersion: "r1",
    }, known).ok).toBe(false);
  });
});
