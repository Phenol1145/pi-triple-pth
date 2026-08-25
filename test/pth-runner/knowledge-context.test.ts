import { describe, expect, it, vi } from "vitest";
import type { KnowledgeEvidenceRef } from "@away_from/pth-memory";
import { DisciplineCatalogBuilder } from "../../src/pth/catalog/index.js";
import {
  computeKnowledgeQueryFingerprint,
  contextPromptProjection,
  createKnowledgeContextProvider,
  formatKnowledgeContextPromptRows,
  fnv1aHex,
  type KnowledgeContextEntry,
  type KnowledgeContextInput,
  type KnowledgeMemoryEntry,
} from "../../src/pth/runner/knowledge-context.js";
import { buildMemoryDirectorySnapshot, regionEntryIds } from "../../src/pth/execution/memory-directory.js";
import { createLayeredKnowledgeRetriever } from "../../src/pth/execution/layered-knowledge-retriever.js";
import { createVerifiedTaskReadScopeFactory } from "../../src/pth/execution/authorization/verified-task-read-scope.js";
import { createExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import { filterKnowledgeEntriesByQueryText, rankKnowledgeEntries } from "../../src/pth/execution/knowledge-ranking.js";
import { createKnowledgeBroker } from "../../src/pth/execution/knowledge-broker.js";
import {
  N28_DOMAIN_IDS, N28_REGIONS, N28_RESPONSIBILITIES, N28_WORKERS,
  n28AuthorizedCorpus, n28DirectoryInputs,
} from "../../scripts/tools/n28-feasibility-fixture.js";

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
            content: "quadratic formula",
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
    expect(item.evidence).toEqual([]);
  });

  it("context entries carry structured KnowledgeEvidenceRef[]", async () => {
    const evidence: KnowledgeEvidenceRef[] = [
      { sourceId: "pilot-source:pl-jls", locator: "JLS SE23 §4.12.2", sourceVersion: "Java SE 23", artifactHash: "a".repeat(64) },
      { sourceId: "pilot-source:pl-rust-reference", locator: "Rust Reference: type system" },
    ];
    const provider = createKnowledgeContextProvider({
      memory: {
        retrieve: async () => [
          entry({
            id: "e1",
            anchors: ["math", "quadratic"],
            content: "quadratic formula solves quadratic equations",
            meta: { version: 2, evidence },
          }),
        ],
      },
      isVisible: () => true,
    });

    const ctx = await provider.build({ ...baseInput, text: "quadratic formula" });
    const item = ctx.entries[0]!;

    expect(item.evidence).toEqual(evidence);
    expect(item.evidence[0]).toMatchObject({
      sourceId: "pilot-source:pl-jls",
      locator: "JLS SE23 §4.12.2",
      sourceVersion: "Java SE 23",
      artifactHash: "a".repeat(64),
    });
  });

  it("entry without meta.evidence yields evidence: [] (not provenance)", async () => {
    const provider = createKnowledgeContextProvider({
      memory: {
        retrieve: async () => [
          entry({
            id: "e1",
            anchors: ["math", "quadratic"],
            content: "quadratic formula solves quadratic equations",
            meta: { version: 1, provenance: { sourceTaskId: "task-1", producerRole: "developer" } },
          }),
        ],
      },
      isVisible: () => true,
    });

    const ctx = await provider.build({ ...baseInput, text: "quadratic formula" });
    const item = ctx.entries[0]!;

    expect(item.evidence).toEqual([]);
    expect(item.evidence).not.toEqual([{ sourceTaskId: "task-1", producerRole: "developer" }]);
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

describe("N28 T4：layered Context 与 prompt 投影", () => {
  it("fingerprint：workerId 缺席旧值逐字节不变；存在时追加独立分量", () => {
    const base = computeKnowledgeQueryFingerprint(baseInput);
    expect(computeKnowledgeQueryFingerprint({ ...baseInput })).toBe(base);
    const withWorker = computeKnowledgeQueryFingerprint({ ...baseInput, workerId: "10000000-0000-4000-8000-000000000011" });
    expect(withWorker).not.toBe(base);
  });

  it("contextPromptProjection 只含白名单字段；evidence/meta 变化同步改变 prompt 字节与投影", () => {
    const make = (overrides: Partial<KnowledgeContextEntry> = {}): KnowledgeContextEntry => ({
      entryId: "e1",
      version: 1,
      anchor: "math",
      summary: "quadratic formula",
      evidence: [{ sourceId: "s1" } as KnowledgeEvidenceRef],
      exposedMeta: { kind: "domain-fact", domains: ["math"] },
      ...overrides,
    });
    const row = contextPromptProjection(make());
    expect(Object.keys(row).sort()).toEqual(["anchor", "entryId", "evidence", "meta", "summary"]);
    expect(row).not.toHaveProperty("version");
    const a = formatKnowledgeContextPromptRows([row]);
    const b = formatKnowledgeContextPromptRows([contextPromptProjection(make({ evidence: [{ sourceId: "s2" } as KnowledgeEvidenceRef] }))]);
    const c = formatKnowledgeContextPromptRows([contextPromptProjection(make({ exposedMeta: { kind: "domain-method", domains: ["math"] } }))]);
    expect(b).not.toBe(a);
    expect(c).not.toBe(a);
  });

  it("同一 worker/query/snapshot 下 Context 与 Broker 的 trace 快照与 selected IDs 一致", async () => {
    const clock = () => new Date("2030-01-01T00:00:00.000Z");
    const grantService = createExecutionGrantService({ keyProvider: createHmacGrantKeyProvider({ secret: "n28-feasibility-test-secret-0123456789" }), clock });
    const authority = createVerifiedTaskReadScopeFactory({
      grantService,
      grantForTask: () => { throw new Error("unused"); },
    });
    const corpus = n28AuthorizedCorpus();
    const directoryEntries = n28DirectoryInputs(corpus);
    const directory = buildMemoryDirectorySnapshot({
      tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS,
      workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES,
      entries: directoryEntries,
    });
    const retriever = createLayeredKnowledgeRetriever<KnowledgeMemoryEntry>(directory, { knownDomainIds: N28_DOMAIN_IDS, entries: directoryEntries }, { clock });
    const wavePort = async ({ authorization: waveAuth, candidateScope, regionIds, queryText, limit }: import("../../src/pth/execution/layered-knowledge-retriever.js").LayeredSearchWaveInput) => {
      const regionSet = new Set(regionIds.flatMap((id) => regionEntryIds(directory, id)));
      const authorized = corpus.filter((e) => e.tenantId === waveAuth.tenantId && e.status === "official");
      const inWave = candidateScope === "global" ? authorized : authorized.filter((e) => regionSet.has(e.id));
      const matching = filterKnowledgeEntriesByQueryText(inWave, queryText, { strict: true });
      const ranked = rankKnowledgeEntries(matching, { queryText, domains: ["mathematics"] });
      return { entries: ranked.slice(0, limit), candidateCount: authorized.length, visibleCount: authorized.length, scannedCount: authorized.length, completeForQuery: true };
    };
    const provider = createKnowledgeContextProvider({
      memory: { retrieve: async () => corpus },
      isVisible: () => true,
      layeredRetriever: retriever,
      layeredSearchWave: wavePort,
      clock,
    });
    const broker = createKnowledgeBroker({
      grantService,
      dataWorld: { queryReadOnly: async () => [], memory: { retrieve: async () => corpus, get: async () => undefined } },
      isVisible: () => true,
      layeredRetriever: retriever,
      layeredSearchWave: wavePort,
      verifiedReadScopeAuthority: authority,
      clock,
    });

    const worker = N28_WORKERS.algebra;
    const grant = grantService.issue({
      lease: { taskId: "task-n28", leaseId: "20000000-0000-4000-8000-000000000001", generation: 1 },
      scope: { tenantId: "tenant-a", principalId: `worker:${worker.workerId}`, roles: ["researcher"], traceId: "trace-n28", space: "meta" },
      workspace: { tenantId: "tenant-a", workspaceId: "ws-n28", taskId: "task-n28" },
      language: "ts",
      capabilities: ["memory.read"],
      ttlMs: 120_000,
    });
    const brokerResult = await broker.query({
      grant, op: "search", queryText: "token:alg-01", domains: ["mathematics"], limit: 8,
      worker, leaseDeadlineAt: "2030-01-01T00:02:00.000Z",
    });
    expect(brokerResult.ok).toBe(true);
    const brokerEntries = brokerResult.ok ? (brokerResult.entries as Array<{ id: string }>) : [];

    const scope = authority.verifyBrokerGrant({ grant, worker, leaseDeadlineAt: "2030-01-01T00:02:00.000Z" });
    const context = await provider.build({
      tenantId: "tenant-a", space: "meta", roleId: "researcher", domains: ["mathematics"],
      title: "n28", text: "token:alg-01", catalogVersion: "",
      workerId: worker.workerId, authorization: scope,
    });
    expect(context.retrievalTrace?.directorySnapshotId).toBe(directory.snapshotId);
    expect(brokerResult.ok && brokerResult.retrievalTrace?.directorySnapshotId).toBe(directory.snapshotId);
    expect(context.entries.map((e) => e.entryId)).toEqual(brokerEntries.map((e) => e.id));
    expect(context.retrievalTrace?.waves.map((w) => w.selectedEntryIds)).toEqual(
      brokerResult.ok && brokerResult.retrievalTrace ? brokerResult.retrievalTrace.waves.map((w) => w.selectedEntryIds) : [],
    );
  });
});
