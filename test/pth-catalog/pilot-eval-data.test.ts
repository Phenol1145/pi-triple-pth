/**
 * test/pth-catalog/pilot-eval-data.test.ts — N23 K5 评测批：数据形状/引用完整性验收。
 */

import { describe, expect, it } from "vitest";
import { buildPilotCatalog, PILOT_DOMAIN_OVERRIDES } from "../../src/pth/catalog/data/pilot-domain-overrides.js";
import { PILOT_EVAL_QUERIES } from "../../src/pth/catalog/data/pilot-eval-queries.js";
import { PILOT_KNOWLEDGE } from "../../src/pth/catalog/data/pilot-knowledge.js";
import { hashSource, PILOT_SOURCES } from "../../src/pth/catalog/data/pilot-source-registry.js";

const DOMAINS = ["programming-languages", "materials-science"] as const;

describe("pilot-eval-data：数据形状与引用完整性", () => {
  it("PILOT_SOURCES ≥10 且每个域 ≥5，字段合法", () => {
    expect(PILOT_SOURCES.length).toBeGreaterThanOrEqual(10);
    for (const domain of DOMAINS) {
      const rows = PILOT_SOURCES.filter((source) => source.domain === domain);
      expect(rows.length, `${domain} sources`).toBeGreaterThanOrEqual(5);
    }

    const ids = new Set<string>();
    for (const source of PILOT_SOURCES) {
      expect(source.id).toBeTruthy();
      expect(ids.has(source.id), `duplicate source id ${source.id}`).toBe(false);
      ids.add(source.id);
      expect(DOMAINS).toContain(source.domain as (typeof DOMAINS)[number]);
      expect(source.authority).toBeTruthy();
      expect(source.uri).toMatch(/^https?:\/\//);
      expect(source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(source.contentHash).toBe(hashSource(source.uri, source.version, source.authority));
      expect(source.contentHash).toMatch(/^[0-9a-f]{64}$/);
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

  it("PILOT_EVAL_QUERIES = 60 条（每域 30），id 唯一且 expectedEntryIds 合法", () => {
    expect(PILOT_EVAL_QUERIES).toHaveLength(60);
    for (const domain of DOMAINS) {
      const rows = PILOT_EVAL_QUERIES.filter((query) => query.domain === domain);
      expect(rows, `${domain} queries`).toHaveLength(30);
    }

    const knowledgeByDomain = new Map<string, Set<string>>();
    for (const entry of PILOT_KNOWLEDGE) {
      const set = knowledgeByDomain.get(entry.domain) ?? new Set<string>();
      set.add(entry.id);
      knowledgeByDomain.set(entry.domain, set);
    }

    const ids = new Set<string>();
    for (const query of PILOT_EVAL_QUERIES) {
      expect(query.id).toMatch(/^(pl|ms)-\d{2}$/);
      expect(ids.has(query.id), `duplicate query id ${query.id}`).toBe(false);
      ids.add(query.id);
      expect(DOMAINS).toContain(query.domain as (typeof DOMAINS)[number]);
      expect(query.text.trim()).not.toBe("");
      expect(query.expectedEntryIds.length).toBeGreaterThan(0);
      for (const entryId of query.expectedEntryIds) {
        expect(knowledgeByDomain.get(query.domain)?.has(entryId), `${query.id} 的 ${entryId} 不存在或不属于 ${query.domain}`).toBe(true);
      }
    }
  });

  it("查询文本基本可被 resolver alias 扫描命中（每域 ≥90%）", () => {
    const aliasesByDomain = new Map<string, string[]>();
    for (const override of PILOT_DOMAIN_OVERRIDES) {
      aliasesByDomain.set(override.id, override.aliases.map((alias) => alias.toLocaleLowerCase()));
    }

    for (const domain of DOMAINS) {
      const aliases = aliasesByDomain.get(domain) ?? [];
      const rows = PILOT_EVAL_QUERIES.filter((query) => query.domain === domain);
      const covered = rows.filter((query) => {
        const haystack = query.text.toLocaleLowerCase();
        return aliases.some((alias) => haystack.includes(alias));
      }).length;
      expect(covered, `${domain} alias coverage ${covered}/${rows.length}`).toBeGreaterThanOrEqual(rows.length * 0.9);
    }
  });

  it("buildPilotCatalog() 合并 overrides 后构建快照，且别名追加去重", () => {
    const catalog = buildPilotCatalog();
    expect(catalog.get("programming-languages")).toBeTruthy();
    expect(catalog.get("materials-science")).toBeTruthy();

    for (const override of PILOT_DOMAIN_OVERRIDES) {
      const def = catalog.get(override.id)!;
      for (const alias of override.aliases) {
        expect(def.aliases.map((a) => a.toLocaleLowerCase())).toContain(alias.toLocaleLowerCase());
      }
      // 去重：大小写不敏感下不应重复
      const lower = def.aliases.map((alias) => alias.toLocaleLowerCase());
      expect(new Set(lower).size).toBe(lower.length);
    }
  });
});
