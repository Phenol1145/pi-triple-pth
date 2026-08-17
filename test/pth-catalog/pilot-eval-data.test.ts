/**
 * test/pth-catalog/pilot-eval-data.test.ts — N23 K5 + F4 评测批：数据形状/引用完整性验收。
 *
 * F4 扩展：
 *  - source registry 改 registryFingerprint + artifactHash（来自 pilot-source-snapshots）；
 *  - 查询集 84 条 = 60 标准 + 每域 6 hard negative + 4 多域 + 2 混淆；
 *  - 生产别名覆盖来自 discipline-alias-overrides.ts，catalog 由 DISCIPLINE_DEFINITIONS 构建。
 */

import { describe, expect, it } from "vitest";
import { DisciplineCatalogBuilder } from "../../src/pth/catalog/discipline-catalog.js";
import { DISCIPLINE_DEFINITIONS } from "../../src/pth/catalog/data/discipline-catalog-data.js";
import { PRODUCTION_DOMAIN_ALIAS_OVERRIDES } from "../../src/pth/catalog/data/discipline-alias-overrides.js";
import { PILOT_EVAL_QUERIES } from "../../src/pth/catalog/data/pilot-eval-queries.js";
import { PILOT_KNOWLEDGE } from "../../src/pth/catalog/data/pilot-knowledge.js";
import { registryFingerprintOf, PILOT_SOURCES } from "../../src/pth/catalog/data/pilot-source-registry.js";
import { artifactHashOf, PILOT_SOURCE_SNAPSHOTS } from "../../src/pth/catalog/data/pilot-source-snapshots.js";

const DOMAINS = ["programming-languages", "materials-science"] as const;

function buildCatalog() {
  const builder = new DisciplineCatalogBuilder();
  for (const def of DISCIPLINE_DEFINITIONS) builder.add(def);
  return builder.build();
}

describe("pilot-eval-data：数据形状与引用完整性", () => {
  it("PILOT_SOURCES ≥10 且每个域 ≥5，字段合法（registryFingerprint + artifactHash）", () => {
    expect(PILOT_SOURCES.length).toBeGreaterThanOrEqual(10);
    for (const domain of DOMAINS) {
      const rows = PILOT_SOURCES.filter((source) => source.domain === domain);
      expect(rows.length, `${domain} sources`).toBeGreaterThanOrEqual(5);
    }

    const snapshotBySource = new Map(PILOT_SOURCE_SNAPSHOTS.map((snap) => [snap.sourceId, snap]));
    const ids = new Set<string>();
    for (const source of PILOT_SOURCES) {
      expect(source.id).toBeTruthy();
      expect(ids.has(source.id), `duplicate source id ${source.id}`).toBe(false);
      ids.add(source.id);
      expect(DOMAINS).toContain(source.domain as (typeof DOMAINS)[number]);
      expect(source.authority).toBeTruthy();
      expect(source.uri).toMatch(/^https?:\/\//);
      expect(source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(source.registryFingerprint).toBe(registryFingerprintOf(source.uri, source.version, source.authority));
      expect(source.registryFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(source.artifactHash).toMatch(/^[0-9a-f]{64}$/);
      const snap = snapshotBySource.get(source.id);
      expect(snap, `source ${source.id} 必须存在 snapshot`).toBeTruthy();
      expect(source.artifactHash).toBe(artifactHashOf(snap!.snapshotContent));
    }
  });

  it("PILOT_SOURCE_SNAPSHOTS 每条 1–2 句权威摘录且 artifactHash=sha256(snapshotContent)", () => {
    const sourceIds = new Set(PILOT_SOURCES.map((source) => source.id));
    expect(PILOT_SOURCE_SNAPSHOTS.length).toBe(PILOT_SOURCES.length);
    for (const snap of PILOT_SOURCE_SNAPSHOTS) {
      expect(sourceIds.has(snap.sourceId), `snapshot sourceId ${snap.sourceId} 不存在`).toBe(true);
      expect(snap.snapshotContent.trim()).not.toBe("");
      expect(snap.artifactHash).toBe(artifactHashOf(snap.snapshotContent));
      expect(snap.artifactHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("PILOT_KNOWLEDGE = 24 条（每域 12），content ≤300 且 evidence.sourceId 都存在", () => {
    expect(PILOT_KNOWLEDGE).toHaveLength(24);
    for (const domain of DOMAINS) {
      const rows = PILOT_KNOWLEDGE.filter((entry) => entry.domain === domain);
      expect(rows, `${domain} knowledge`).toHaveLength(12);
    }

    const sourceIds = new Set(PILOT_SOURCES.map((source) => source.id));
    const ids = new Set<string>();
    for (const entry of PILOT_KNOWLEDGE) {
      expect(entry.kind).toBe("domain-fact");
      expect(ids.has(entry.id), `duplicate knowledge id ${entry.id}`).toBe(false);
      ids.add(entry.id);
      expect(entry.anchors).toContain(entry.domain);
      expect(entry.anchors.length).toBeGreaterThan(1); // domain id + 概念锚点
      expect(entry.content.length).toBeLessThanOrEqual(300);
      expect(entry.evidence.length).toBeGreaterThan(0);
      for (const evidence of entry.evidence) {
        expect(sourceIds.has(evidence.sourceId), `${entry.id} 的 sourceId ${evidence.sourceId} 不存在`).toBe(true);
        expect(evidence.locator.trim()).not.toBe("");
      }
    }
  });

  it("PILOT_EVAL_QUERIES = 84 条（每域 42：30 标准 + 6 hard negative + 4 多域 + 2 混淆）", () => {
    expect(PILOT_EVAL_QUERIES).toHaveLength(84);

    for (const domain of DOMAINS) {
      const rows = PILOT_EVAL_QUERIES.filter((query) => query.domain === domain);
      expect(rows, `${domain} queries`).toHaveLength(42);
      expect(rows.filter((q) => q.expectNoKnowledge), `${domain} hard negative`).toHaveLength(6);
      expect(rows.filter((q) => q.expectedDomains && q.expectedDomains.length > 0), `${domain} multi-domain`).toHaveLength(4);
      expect(rows.filter((q) => q.distractorDomain), `${domain} distractor`).toHaveLength(2);
    }

    const knowledgeByDomain = new Map<string, Set<string>>();
    for (const entry of PILOT_KNOWLEDGE) {
      const set = knowledgeByDomain.get(entry.domain) ?? new Set<string>();
      set.add(entry.id);
      knowledgeByDomain.set(entry.domain, set);
    }

    const ids = new Set<string>();
    for (const query of PILOT_EVAL_QUERIES) {
      expect(query.id).toMatch(/^(pl|ms)-(\d{2}|hn-\d{2}|md-\d{2}|ds-\d{2})$/);
      expect(ids.has(query.id), `duplicate query id ${query.id}`).toBe(false);
      ids.add(query.id);
      expect(DOMAINS).toContain(query.domain as (typeof DOMAINS)[number]);
      expect(query.text.trim()).not.toBe("");

      if (query.expectNoKnowledge) {
        expect(query.expectedEntryIds).toEqual([]);
        expect(query.expectedDomains).toBeUndefined();
        expect(query.distractorDomain).toBeUndefined();
      } else if (query.expectedDomains && query.expectedDomains.length > 0) {
        expect(query.expectedEntryIds).toEqual([]);
        expect(query.expectedDomains).toHaveLength(2);
        for (const expected of query.expectedDomains) {
          expect(DOMAINS).toContain(expected as (typeof DOMAINS)[number]);
        }
        expect(query.distractorDomain).toBeUndefined();
      } else if (query.distractorDomain) {
        expect(query.expectedEntryIds).toEqual([]);
        expect(query.expectedDomains).toBeUndefined();
      } else {
        // 标准 60 题：期望 top-5 命中且 entry 属于同域
        expect(query.expectedEntryIds.length).toBeGreaterThan(0);
        for (const entryId of query.expectedEntryIds) {
          expect(knowledgeByDomain.get(query.domain)?.has(entryId), `${query.id} 的 ${entryId} 不存在或不属于 ${query.domain}`).toBe(true);
        }
      }
    }
  });

  it("标准查询文本基本可被生产 catalog alias 扫描命中（每域 ≥90%）", () => {
    const aliasesByDomain = new Map<string, string[]>();
    for (const override of PRODUCTION_DOMAIN_ALIAS_OVERRIDES) {
      aliasesByDomain.set(override.id, override.aliases.map((alias) => alias.toLocaleLowerCase()));
    }

    for (const domain of DOMAINS) {
      const aliases = aliasesByDomain.get(domain) ?? [];
      const rows = PILOT_EVAL_QUERIES.filter((q) => q.domain === domain && !q.expectNoKnowledge && !q.expectedDomains && !q.distractorDomain);
      const covered = rows.filter((query) => {
        const haystack = query.text.toLocaleLowerCase();
        return aliases.some((alias) => haystack.includes(alias));
      }).length;
      expect(covered, `${domain} alias coverage ${covered}/${rows.length}`).toBeGreaterThanOrEqual(rows.length * 0.9);
    }
  });

  it("生产 catalog（DISCIPLINE_DEFINITIONS + DisciplineCatalogBuilder）已包含别名覆盖，且别名去重", () => {
    const catalog = buildCatalog();
    expect(catalog.get("programming-languages")).toBeTruthy();
    expect(catalog.get("materials-science")).toBeTruthy();

    for (const override of PRODUCTION_DOMAIN_ALIAS_OVERRIDES) {
      const def = catalog.get(override.id)!;
      for (const alias of override.aliases) {
        expect(def.aliases.map((a) => a.toLocaleLowerCase())).toContain(alias.toLocaleLowerCase());
      }
      const lower = def.aliases.map((alias) => alias.toLocaleLowerCase());
      expect(new Set(lower).size).toBe(lower.length);
    }
  });
});
