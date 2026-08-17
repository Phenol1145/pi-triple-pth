/**
 * test/pth-catalog/discipline-catalog-data.test.ts — K0 生成数据验收测试。
 *
 * 数量钉死（manifest 复算，取代文档手写总数）：
 * category=5、discipline=32、sub-discipline=147、total=184。
 */

import { describe, expect, it } from "vitest";
import { DisciplineCatalogBuilder } from "../../src/pth/catalog/discipline-catalog.js";
import { DOMAIN_ID_RE, type DomainDefinition } from "../../src/pth/contracts/domains.js";
import { DISCIPLINE_DEFINITIONS } from "../../src/pth/catalog/data/discipline-catalog-data.js";

const EXPECTED_COUNTS = { category: 5, discipline: 32, subDiscipline: 147, total: 184 };
/** 生成后回填：scripts/build-discipline-catalog.ts 复算出的稳定 FNV-1a 指纹 */
const EXPECTED_VERSION = "d8429659";

function levelCounts(defs: readonly DomainDefinition[]) {
  const counts = { category: 0, discipline: 0, subDiscipline: 0, total: defs.length };
  for (const d of defs) {
    if (d.level === "category") counts.category += 1;
    else if (d.level === "discipline") counts.discipline += 1;
    else if (d.level === "sub-discipline") counts.subDiscipline += 1;
  }
  return counts;
}

function build() {
  const builder = new DisciplineCatalogBuilder();
  for (const d of DISCIPLINE_DEFINITIONS) builder.add(d);
  return builder.build();
}

describe("discipline-catalog-data：生成数据验收", () => {
  it("counts = 5/32/147/184", () => {
    expect(levelCounts(DISCIPLINE_DEFINITIONS)).toEqual(EXPECTED_COUNTS);
  });

  it("全部 parents 可解析", () => {
    const ids = new Set(DISCIPLINE_DEFINITIONS.map((d) => d.id));
    for (const d of DISCIPLINE_DEFINITIONS) {
      for (const parent of d.parents) {
        expect(ids.has(parent), `${d.id} 的 parent ${parent} 不存在`).toBe(true);
      }
    }
  });

  it("全部节点通过契约校验且 id/level/names 合规", () => {
    for (const d of DISCIPLINE_DEFINITIONS) {
      expect(d.id, d.id).toMatch(DOMAIN_ID_RE);
      expect(["category", "discipline", "sub-discipline"]).toContain(d.level);
      expect(d.names["zh-CN"]).toBeTruthy();
      expect(d.names.en).toBe(d.id);
      expect(d.aliases).toEqual([]);
      expect(d.methodAnchors).toEqual([]);
      expect(d.sourceRegistryIds).toEqual([]);
      expect(d.toolAnchors).toEqual([]);
    }
  });

  it("build() 无环且 list 按 id 排序", () => {
    const snap = build();
    const sortedIds = [...DISCIPLINE_DEFINITIONS].map((d) => d.id).sort((a, b) => a.localeCompare(b));
    expect(snap.list().map((d) => d.id)).toEqual(sortedIds);
    expect(snap.counts()).toEqual(EXPECTED_COUNTS);
  });

  it("version 稳定：正向/反向 add 同版本，且钉死指纹", () => {
    const forward = build();
    const backward = new DisciplineCatalogBuilder();
    for (const d of [...DISCIPLINE_DEFINITIONS].reverse()) backward.add(d);
    const backwardSnap = backward.build();
    expect(forward.version).toBe(backwardSnap.version);
    expect(forward.version).toBe(EXPECTED_VERSION);
  });
});
