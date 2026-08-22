/**
 * test/pth-catalog/discipline-catalog-data.test.ts — K0 生成数据验收测试。
 *
 * 数量钉死（manifest 复算，取代文档手写总数）：
 * category=5、discipline=32、sub-discipline=147、total=184。
 * F4（AB-06）：生成数据合并生产别名覆盖（discipline-alias-overrides.ts），
 * computeVersion 覆盖全部 catalog 行为字段 → version 不再 d8429659。
 */

import { describe, expect, it } from "vitest";
import { DisciplineCatalogBuilder } from "../../src/pth/catalog/discipline-catalog.js";
import { DOMAIN_ID_RE, type DomainDefinition } from "@away_from/pth-contracts";
import { DISCIPLINE_DEFINITIONS } from "../../src/pth/catalog/data/discipline-catalog-data.js";
import { PRODUCTION_DOMAIN_ALIAS_OVERRIDES } from "../../src/pth/catalog/data/discipline-alias-overrides.js";

const EXPECTED_COUNTS = { category: 5, discipline: 32, subDiscipline: 147, total: 184 };
/** F4 之前旧版本指纹——computeVersion 扩展后必须变化。 */
const OLD_VERSION = "d8429659";
const OVERRIDDEN_DOMAINS = new Set(PRODUCTION_DOMAIN_ALIAS_OVERRIDES.map((o) => o.id));

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
      if (OVERRIDDEN_DOMAINS.has(d.id)) {
        expect(d.aliases.length, `${d.id} 应包含生产别名`).toBeGreaterThan(0);
      } else {
        expect(d.aliases).toEqual([]);
      }
      expect(d.methodAnchors).toEqual([]);
      expect(d.sourceRegistryIds).toEqual([]);
      expect(d.toolAnchors).toEqual([]);
    }
  });

  it("生产别名覆盖已合并且 aliases 追加去重（大小写不敏感）", () => {
    const byId = new Map(DISCIPLINE_DEFINITIONS.map((d) => [d.id, d]));
    for (const override of PRODUCTION_DOMAIN_ALIAS_OVERRIDES) {
      const def = byId.get(override.id);
      expect(def, `override id ${override.id} 必须存在`).toBeTruthy();
      for (const alias of override.aliases) {
        expect(def!.aliases.map((a) => a.toLocaleLowerCase())).toContain(alias.toLocaleLowerCase());
      }
      const lower = def!.aliases.map((a) => a.toLocaleLowerCase());
      expect(new Set(lower).size).toBe(lower.length);
    }
  });

  it("build() 无环且 list 按 id 排序", () => {
    const snap = build();
    const sortedIds = [...DISCIPLINE_DEFINITIONS].map((d) => d.id).sort((a, b) => a.localeCompare(b));
    expect(snap.list().map((d) => d.id)).toEqual(sortedIds);
    expect(snap.counts()).toEqual(EXPECTED_COUNTS);
  });

  it("version 稳定：正向/反向 add 同版本，且不再等于旧指纹 d8429659", () => {
    const forward = build();
    const backward = new DisciplineCatalogBuilder();
    for (const d of [...DISCIPLINE_DEFINITIONS].reverse()) backward.add(d);
    const backwardSnap = backward.build();
    expect(forward.version).toBe(backwardSnap.version);
    expect(forward.version).toMatch(/^[0-9a-f]{8}$/);
    expect(forward.version).not.toBe(OLD_VERSION);
  });
});
