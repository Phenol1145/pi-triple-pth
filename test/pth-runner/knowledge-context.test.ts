import { describe, expect, it, vi } from "vitest";
import { DisciplineCatalogBuilder } from "../../src/pth/catalog/index.js";
import {
  computeKnowledgeQueryFingerprint,
  createKnowledgeContextProvider,
  fnv1aHex,
  type KnowledgeContextInput,
  type KnowledgeMemoryEntry,
} from "../../src/pth/runner/knowledge-context.js";

const baseInput: KnowledgeContextInput = {
  tenantId: "tenant-a",
  space: "meta",
  roleId: "developer",
  domains: ["math"],
  title: "solve x",
  text: "solve the quadratic equation",
  catalogVersion: "cat-v1",
};

function entry(overrides: Partial<KnowledgeMemoryEntry> = {}): KnowledgeMemoryEntry {
  return {
    id: "e1",
    kind: "domain-fact",
    anchors: ["math"],
    status: "official",
    content: "quadratic formula",
    meta: {},
    ...overrides,
  };
}

function buildCatalog() {
  const builder = new DisciplineCatalogBuilder();
  builder.add({
    id: "math",
    names: { "zh-CN": "数学" },
    aliases: [],
    parents: [],
    level: "discipline",
    description: "数学",
    methodAnchors: [],
    sourceRegistryIds: [],
    toolAnchors: [],
  });
  builder.add({
    id: "algebra",
    names: { "zh-CN": "代数" },
    aliases: [],
    parents: ["math"],
    level: "sub-discipline",
    description: "代数",
    methodAnchors: [],
    sourceRegistryIds: [],
    toolAnchors: [],
  });
  builder.add({
    id: "geometry",
    names: { "zh-CN": "几何" },
    aliases: [],
    parents: ["math"],
    level: "sub-discipline",
    description: "几何",
    methodAnchors: [],
    sourceRegistryIds: [],
    toolAnchors: [],
  });
  return builder.build();
}

describe("knowledge-context（K3 Phase 3）", () => {
  it("FNV-1a 32bit 与 queryFingerprint 确定性（同输入同指纹，domains 排序无关）", () => {
    expect(fnv1aHex("")).toBe("811c9dc5");

    const a = computeKnowledgeQueryFingerprint(baseInput);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(computeKnowledgeQueryFingerprint({ ...baseInput })).toBe(a);
    expect(computeKnowledgeQueryFingerprint({ ...baseInput, domains: ["algebra", "math"] })).toBe(
      computeKnowledgeQueryFingerprint({ ...baseInput, domains: ["math", "algebra"] }),
    );
    expect(computeKnowledgeQueryFingerprint({ ...baseInput, title: "other" })).not.toBe(a);
  });

  it("空 domains 不检索，返回空 entries 与 kc-<fingerprint> id", async () => {
    const retrieve = vi.fn(async () => [] as KnowledgeMemoryEntry[]);
    const provider = createKnowledgeContextProvider({
      memory: { retrieve },
      isVisible: () => true,
    });

    const ctx = await provider.build({ ...baseInput, domains: [] });

    expect(retrieve).not.toHaveBeenCalled();
    expect(ctx.domains).toEqual([]);
    expect(ctx.entries).toEqual([]);
    expect(ctx.omitted).toEqual({ count: 0, reason: "budget" });
    expect(ctx.id).toBe(`kc-${ctx.queryFingerprint}`);
  });

  it("检索透传 anchors/kinds/status/tenantId，并过 space 可见性过滤", async () => {
    const retrieveCalls: Array<{ anchors?: string[]; kinds?: string[]; status?: string[]; tenantId?: string }> = [];
    const provider = createKnowledgeContextProvider({
      memory: {
        retrieve: async (opts) => {
          retrieveCalls.push(opts);
          return [
            entry({ id: "v1", meta: { spaceScope: { space: "meta", visibility: "public" } } }),
            entry({ id: "h1", meta: { spaceScope: { space: "other", visibility: "private" } } }),
          ];
        },
      },
      isVisible: (meta, space) => {
        const scope = (meta as { spaceScope?: { space?: string; visibility?: string } } | undefined)?.spaceScope;
        if (!scope || scope.visibility === "public") return true;
        return scope.space === space;
      },
    });

    const ctx = await provider.build({ ...baseInput, domains: ["algebra"] });

    expect(retrieveCalls).toHaveLength(1);
    expect(retrieveCalls[0]).toEqual({
      anchors: ["algebra"],
      kinds: ["domain-fact", "domain-method", "skill", "task-insight"],
      status: ["official"],
      tenantId: "tenant-a",
    });
    expect(ctx.entries.map((e) => e.entryId)).toEqual(["v1"]);
  });

  it("relevance = anchors ∩ (domains + catalog ancestors)，降序后 id 升序", async () => {
    const catalog = buildCatalog();
    const provider = createKnowledgeContextProvider({
      catalog,
      memory: {
        retrieve: async () => [
          entry({ id: "e1", anchors: ["algebra"] }),
          entry({ id: "e2", anchors: ["algebra", "math"] }),
          entry({ id: "e3", anchors: ["geometry"] }),
        ],
      },
      isVisible: () => true,
    });

    const ctx = await provider.build({ ...baseInput, domains: ["algebra"], catalogVersion: catalog.version });

    expect(ctx.entries.map((e) => e.entryId)).toEqual(["e2", "e1", "e3"]);
  });

  it("maxEntries 截断 + omitted budget", async () => {
    const provider = createKnowledgeContextProvider({
      maxEntries: 1,
      memory: {
        retrieve: async () => [
          entry({ id: "e1", anchors: ["math"] }),
          entry({ id: "e2", anchors: ["math"] }),
        ],
      },
      isVisible: () => true,
    });

    const ctx = await provider.build(baseInput);

    expect(ctx.entries.map((e) => e.entryId)).toEqual(["e1"]);
    expect(ctx.omitted).toEqual({ count: 1, reason: "budget" });
  });

  it("summary 单行化截断、version/evidence 取 meta 字段", async () => {
    const provider = createKnowledgeContextProvider({
      summaryChars: 12,
      memory: {
        retrieve: async () => [
          entry({
            id: "e1",
            anchors: ["math", "algebra"],
            content: "line1\nline2   rest",
            meta: { version: 3, provenance: { source: "s1" } },
          }),
        ],
      },
      isVisible: () => true,
    });

    const ctx = await provider.build(baseInput);
    const item = ctx.entries[0]!;

    expect(item.anchor).toBe("math");
    expect(item.version).toBe(3);
    expect(item.summary).not.toContain("\n");
    expect(item.summary.length).toBeLessThanOrEqual(12);
    expect(item.evidence).toEqual({ source: "s1" });
  });

  it("catalog 存在时 catalogVersion 以快照版本为准", async () => {
    const catalog = buildCatalog();
    const provider = createKnowledgeContextProvider({
      catalog,
      memory: { retrieve: async () => [] },
      isVisible: () => true,
    });

    const ctx = await provider.build({ ...baseInput, domains: [], catalogVersion: "old-version" });

    expect(ctx.catalogVersion).toBe(catalog.version);
    expect(ctx.queryFingerprint).toBe(
      computeKnowledgeQueryFingerprint({ ...baseInput, domains: [], catalogVersion: catalog.version }),
    );
  });
});
