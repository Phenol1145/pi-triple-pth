import { describe, expect, it } from "vitest";
import { createKnowledgeBroker, type KnowledgeMemoryEntry } from "../../src/pth/execution/knowledge-broker.js";
import { createExecutionGrantService, createMemoryReplayGuard } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import type { ExecutionGrant } from "@away_from/pth-contracts";
import { buildMemoryDirectorySnapshot, regionEntryIds } from "../../src/pth/execution/memory-directory.js";
import { createLayeredKnowledgeRetriever } from "../../src/pth/execution/layered-knowledge-retriever.js";
import { createVerifiedTaskReadScopeFactory } from "../../src/pth/execution/authorization/verified-task-read-scope.js";
import { filterKnowledgeEntriesByQueryText, rankKnowledgeEntries } from "../../src/pth/execution/knowledge-ranking.js";
import { isVisible, setSpaceLookup } from "@away_from/pth-memory";
import {
  N28_DOMAIN_IDS, N28_REGIONS, N28_RESPONSIBILITIES, N28_WORKERS,
  n28AuthorizedCorpus, n28DirectoryInputs, n28TrapCorpus,
} from "../../scripts/n28-feasibility-fixture.js";

const SECRET = "knowledge-broker-secret-0123456789";
const key = createHmacGrantKeyProvider({ secret: SECRET });
const grantService = createExecutionGrantService({ keyProvider: key, clock: () => new Date("2030-01-01T00:00:00.000Z") });

function makeGrant(opts: { capabilities?: string[]; space?: string | null; ttlMs?: number } = {}): ExecutionGrant {
  return grantService.issue({
    lease: { taskId: "task-k", leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6", generation: 1 },
    scope: { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-k", ...(opts.space === null ? {} : { space: opts.space ?? "meta" }) },
    workspace: { tenantId: "tenant-a", workspaceId: "ws-k", taskId: "task-k" },
    language: "ts",
    capabilities: opts.capabilities ?? ["memory.read"],
    ttlMs: opts.ttlMs ?? 60_000,
  });
}

function makeBroker() {
  return createKnowledgeBroker({
    grantService,
    dataWorld: {
      queryReadOnly: async () => [
        { meta: { spaceScope: { space: "meta", visibility: "public" } } },
        { meta: { spaceScope: { space: "private-other", visibility: "private" } } },
      ],
      memory: {
        retrieve: async () => [
          { id: "m1", kind: "note", anchors: ["a"], status: "official", content: "x", meta: { spaceScope: { space: "meta", visibility: "public" } } },
          { id: "m2", kind: "note", anchors: ["a"], status: "official", content: "y", meta: { spaceScope: { space: "other", visibility: "private" } } },
        ],
        get: async (id: string) => (id === "m1" ? { id: "m1", kind: "note", anchors: ["a"], status: "official", content: "x", meta: { spaceScope: { space: "meta", visibility: "private" } } } : undefined),
      },
    },
    isVisible: (meta, space) => {
      const scope = (meta as { spaceScope?: { space?: string; visibility?: string } } | undefined)?.spaceScope;
      if (!scope || scope.visibility === "public") return true;
      return scope.space === space;
    },
  });
}

describe("KnowledgeBroker（P2-5）", () => {
  it("grant 缺 memory.read capability → 403", async () => {
    const broker = makeBroker();
    const r = await broker.query({ grant: makeGrant({ capabilities: ["llm.complete"] }), op: "retrieve", anchors: ["a"], space: "forged" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("F2：query 缺 memory.query capability → 403（即使有 memory.read）", async () => {
    const broker = makeBroker();
    const r = await broker.query({ grant: makeGrant({ capabilities: ["memory.read"] }), op: "query", sql: "SELECT kind, meta FROM memory_entries LIMIT 1" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toContain("memory.query");
    }
  });

  it("F2：query 有 memory.query capability → 放行到 meta 校验", async () => {
    const broker = makeBroker();
    const r = await broker.query({ grant: makeGrant({ capabilities: ["memory.read", "memory.query"] }), op: "query", sql: "SELECT kind, meta FROM memory_entries LIMIT 1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows).toHaveLength(1);
  });

  it("grant 无 scope.space → 403 fail-closed", async () => {
    const broker = makeBroker();
    const r = await broker.query({ grant: makeGrant({ space: null }), op: "retrieve", anchors: ["a"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("body 自报 space 被忽略——可见空间只来自 grant.scope.space", async () => {
    const broker = makeBroker();
    const r = await broker.query({ grant: makeGrant({ space: "meta" }), op: "retrieve", anchors: ["a"], space: "private-other" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries?.map((e) => (e as { id: string }).id)).toEqual(["m1"]);
  });

  it("query 缺 meta 列 → 400", async () => {
    const broker = createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: async () => [{ value: 1 }],
        memory: { retrieve: async () => [], get: async () => undefined },
      },
      isVisible: () => true,
    });
    const r = await broker.query({ grant: makeGrant({ capabilities: ["memory.read", "memory.query"] }), op: "query", sql: "SELECT 1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("get 按 grant 空间过滤可见性", async () => {
    const broker = makeBroker();
    const visible = await broker.query({ grant: makeGrant({ space: "meta" }), op: "get", id: "m1" });
    expect(visible.ok).toBe(true);

    const hidden = await broker.query({ grant: makeGrant({ space: "private-other" }), op: "get", id: "m1" });
    expect(hidden.ok).toBe(false);
    if (!hidden.ok) expect(hidden.status).toBe(404);
  });

  it("K1a：retrieve 固定 status=official + tenantId 从 grant.scope.tenantId 透传（draft/archived 不回）", async () => {
    const retrieveCalls: Array<{ anchors?: string[]; kinds?: string[]; status?: string[]; tenantId?: string }> = [];
    const broker = createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: async () => [],
        memory: {
          retrieve: async (opts) => {
            retrieveCalls.push(opts);
            const all = [
              { id: "m-official", kind: "note", anchors: ["a"], status: "official", content: "official", meta: {} },
              { id: "m-draft", kind: "note", anchors: ["a"], status: "draft", content: "draft", meta: {} },
              { id: "m-archived", kind: "note", anchors: ["a"], status: "archived", content: "archived", meta: {} },
            ];
            // 模拟 store 的 status 过滤契约（broker 只向 store 表达 official）
            return all.filter((e) => !opts.status || opts.status.includes(e.status));
          },
          get: async () => undefined,
        },
      },
      isVisible: () => true,
    });
    const r = await broker.query({ grant: makeGrant({ space: "meta" }), op: "retrieve", anchors: ["a"], kinds: ["note"] });
    expect(r.ok).toBe(true);
    expect(retrieveCalls).toHaveLength(1);
    expect(retrieveCalls[0]).toEqual({ anchors: ["a"], kinds: ["note"], status: ["official"], tenantId: "tenant-a" });
    if (r.ok) expect(r.entries?.map((e) => (e as { id: string }).id)).toEqual(["m-official"]);
  });

  it("search：tenant 来自 grant + status official + anchors/kinds 默认 + queryText 大小写不敏感过滤 + id 升序", async () => {
    const retrieveCalls: Array<{ anchors?: string[]; kinds?: string[]; status?: string[]; tenantId?: string }> = [];
    const broker = createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: async () => [],
        memory: {
          retrieve: async (opts) => {
            retrieveCalls.push(opts);
            const all = [
              { id: "b2", kind: "domain-fact", anchors: ["math", "algebra"], status: "official", content: "Quadratic Formula", meta: {} },
              { id: "a1", kind: "domain-method", anchors: ["math"], status: "official", content: "Completing the square", meta: {} },
              { id: "c3", kind: "skill", anchors: ["math"], status: "official", content: "Factor by grouping", meta: {} },
              { id: "d4", kind: "domain-fact", anchors: ["math"], status: "draft", content: "Draft secret", meta: {} },
            ];
            return all.filter((e) => !opts.status || opts.status.includes(e.status));
          },
          get: async () => undefined,
        },
      },
      isVisible: () => true,
    });

    const r = await broker.query({ grant: makeGrant({ space: "meta" }), op: "search", domains: ["math"], queryText: "FORMULA" });

    expect(r.ok).toBe(true);
    expect(retrieveCalls[0]).toEqual({
      anchors: ["math"],
      kinds: ["domain-fact", "domain-method", "skill", "task-insight"],
      status: ["official"],
      tenantId: "tenant-a",
    });
    if (r.ok) {
      expect(r.entries?.map((e) => (e as { id: string }).id)).toEqual(["b2"]);
      expect(r.queryFingerprint).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("search：queryText 零命中时 strict fail-closed 返回空（R5/P1-3）", async () => {
    const broker = createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: async () => [],
        memory: {
          retrieve: async () => [
            { id: "b2", kind: "domain-fact", anchors: ["math"], status: "official", content: "Quadratic Formula", meta: {} },
            { id: "a1", kind: "domain-method", anchors: ["math"], status: "official", content: "Completing the square", meta: {} },
            { id: "c3", kind: "skill", anchors: ["math"], status: "official", content: "Factor by grouping", meta: {} },
          ],
          get: async () => undefined,
        },
      },
      isVisible: () => true,
    });

    const r = await broker.query({ grant: makeGrant({ space: "meta" }), op: "search", domains: ["math"], queryText: "zzzz-no-hit" });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries).toEqual([]);
  });

  it("search：limit 缺省 8、显式上限 20", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `e${String(i).padStart(2, "0")}`,
      kind: "domain-fact",
      anchors: ["math"],
      status: "official",
      content: `entry ${i}`,
      meta: {},
    }));
    const broker = createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: async () => [],
        memory: { retrieve: async () => many, get: async () => undefined },
      },
      isVisible: () => true,
    });

    const rDefault = await broker.query({ grant: makeGrant({ space: "meta" }), op: "search", domains: ["math"] });
    expect(rDefault.ok).toBe(true);
    if (rDefault.ok) expect(rDefault.entries).toHaveLength(8);

    const rCapped = await broker.query({ grant: makeGrant({ space: "meta" }), op: "search", domains: ["math"], limit: 100 });
    expect(rCapped.ok).toBe(true);
    if (rCapped.ok) expect(rCapped.entries).toHaveLength(20);

    const rTwo = await broker.query({ grant: makeGrant({ space: "meta" }), op: "search", domains: ["math"], limit: 2 });
    expect(rTwo.ok).toBe(true);
    if (rTwo.ok) expect(rTwo.entries).toHaveLength(2);
  });

  it("search：结果过 space 可见性过滤；注入 search 时优先于 retrieve 兜底", async () => {
    const searchCalls: Array<{ anchors?: string[]; kinds?: string[]; status?: string[]; tenantId?: string; queryText?: string; limit?: number }> = [];
    const broker = createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: async () => [],
        memory: {
          retrieve: async () => {
            throw new Error("retrieve should not be called when search injected");
          },
          search: async (opts) => {
            searchCalls.push(opts);
            return [
              { id: "m1", kind: "domain-fact", anchors: ["math"], status: "official", content: "visible", meta: { spaceScope: { space: "meta", visibility: "public" } } },
              { id: "m2", kind: "domain-fact", anchors: ["math"], status: "official", content: "hidden", meta: { spaceScope: { space: "private-other", visibility: "private" } } },
            ];
          },
          get: async () => undefined,
        },
      },
      isVisible: (meta, space) => {
        const scope = (meta as { spaceScope?: { space?: string; visibility?: string } } | undefined)?.spaceScope;
        if (!scope || scope.visibility === "public") return true;
        return scope.space === space;
      },
    });

    const r = await broker.query({ grant: makeGrant({ space: "meta" }), op: "search", domains: ["math"], kinds: ["domain-fact"], queryText: "vis", limit: 5 });

    expect(r.ok).toBe(true);
    expect(searchCalls[0]).toEqual({
      anchors: ["math"],
      kinds: ["domain-fact"],
      status: ["official"],
      tenantId: "tenant-a",
      queryText: "vis",
      limit: 5,
    });
    if (r.ok) expect(r.entries?.map((e) => (e as { id: string }).id)).toEqual(["m1"]);
  });

  it("get：非 official 条目返回 404（worker 面只读 official）", async () => {
    const broker = createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: async () => [],
        memory: {
          retrieve: async () => [],
          get: async (id: string) => (id === "draft-1"
            ? { id: "draft-1", kind: "domain-fact", anchors: ["a"], status: "draft", content: "draft", meta: {} }
            : undefined),
        },
      },
      isVisible: () => true,
    });

    const r = await broker.query({ grant: makeGrant({ space: "meta" }), op: "get", id: "draft-1" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("K1a：get tenantId 透传 + 命中后触发 recordConsumption（未命中/不可见不触发）", async () => {
    const getCalls: Array<{ id: string; opts?: { tenantId?: string } }> = [];
    const consumed: Array<{ id: string; tenantId?: string }> = [];
    const broker = createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: async () => [],
        memory: {
          retrieve: async () => [],
          get: async (id: string, opts?: { tenantId?: string }) => {
            getCalls.push({ id, opts });
            if (id === "m1") return { id: "m1", kind: "note", anchors: ["a"], status: "official", content: "x", meta: {} };
            if (id === "m-hidden") return { id: "m-hidden", kind: "note", anchors: ["a"], status: "official", content: "hidden", meta: { spaceScope: { space: "private-other", visibility: "private" } } };
            return undefined;
          },
        },
      },
      isVisible: (meta, space) => {
        const scope = (meta as { spaceScope?: { space?: string; visibility?: string } } | undefined)?.spaceScope;
        if (!scope || scope.visibility === "public") return true;
        return scope.space === space;
      },
      recordConsumption: async (id, tenantId) => {
        consumed.push({ id, tenantId });
      },
    });

    const visible = await broker.query({ grant: makeGrant({ space: "meta" }), op: "get", id: "m1" });
    expect(visible.ok).toBe(true);
    expect(getCalls[0]).toEqual({ id: "m1", opts: { tenantId: "tenant-a" } });
    expect(consumed).toEqual([{ id: "m1", tenantId: "tenant-a" }]);

    // 未命中不触发
    const miss = await broker.query({ grant: makeGrant({ space: "meta" }), op: "get", id: "nope" });
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.status).toBe(404);
    expect(consumed).toHaveLength(1);

    // 命中但空间不可见 → 404 且不触发（全文未消费）
    const hidden = await broker.query({ grant: makeGrant({ space: "meta" }), op: "get", id: "m-hidden" });
    expect(hidden.ok).toBe(false);
    if (!hidden.ok) expect(hidden.status).toBe(404);
    expect(consumed).toHaveLength(1);
  });
});

describe("KnowledgeBroker layered 路径（N28 T4）", () => {
  setSpaceLookup({
    get: (id) => {
      const parent = id === "meta" ? undefined : "meta";
      return { id, parent };
    },
  });

  const clock = () => new Date("2030-01-01T00:00:00.000Z");
  const layeredGrantService = createExecutionGrantService({ keyProvider: key, clock });
  const authority = createVerifiedTaskReadScopeFactory({
    grantService: layeredGrantService,
    grantForTask: () => { throw new Error("not used by broker layered path"); },
  });
  const corpus = [...n28AuthorizedCorpus(), ...n28TrapCorpus()];
  const directoryEntries = n28DirectoryInputs(corpus.filter((e) => e.tenantId === "tenant-a" && e.status === "official"));
  const directory = buildMemoryDirectorySnapshot({
    tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS,
    workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES,
    entries: directoryEntries,
  });
  const retriever = createLayeredKnowledgeRetriever<KnowledgeMemoryEntry>(directory, { knownDomainIds: N28_DOMAIN_IDS, entries: directoryEntries }, { clock });
  let waveCalls = 0;
  const broker = createKnowledgeBroker({
    grantService: layeredGrantService,
    dataWorld: {
      queryReadOnly: async () => [],
      memory: {
        retrieve: async (opts) => corpus.filter((e) => e.tenantId === opts.tenantId && e.status === "official"),
        get: async () => undefined,
      },
    },
    isVisible: (meta, space) => isVisible(meta, space),
    layeredRetriever: retriever,
    layeredSearchWave: async ({ wave, candidateScope, regionIds, queryText, limit }) => {
      waveCalls += 1;
      const regionSet = new Set(regionIds.flatMap((id) => regionEntryIds(directory, id)));
      const authorized = corpus.filter((e) => e.tenantId === "tenant-a" && e.status === "official" && isVisible(e.meta, "meta"));
      const inWave = candidateScope === "global" ? authorized : authorized.filter((e) => regionSet.has(e.id));
      const matching = filterKnowledgeEntriesByQueryText(inWave, queryText, { strict: true });
      const ranked = rankKnowledgeEntries(matching, { queryText, domains: ["mathematics"] });
      return { entries: ranked.slice(0, limit), candidateCount: authorized.length, visibleCount: authorized.length, scannedCount: authorized.length, completeForQuery: true };
    },
    verifiedReadScopeAuthority: authority,
    clock,
  });

  function layeredGrant(capabilities: string[] = ["memory.read"]): ExecutionGrant {
    return layeredGrantService.issue({
      lease: { taskId: "task-n28", leaseId: "20000000-0000-4000-8000-000000000001", generation: 1 },
      scope: { tenantId: "tenant-a", principalId: `worker:${N28_WORKERS.algebra.workerId}`, roles: ["researcher"], traceId: "trace-n28", space: "meta" },
      workspace: { tenantId: "tenant-a", workspaceId: "ws-n28", taskId: "task-n28" },
      language: "ts",
      capabilities,
      ttlMs: 120_000,
    });
  }

  it("真实签名 grant + 真实 retriever：global-only 命中、globalFallback=true、无 trap 条目", async () => {
    const result = await broker.query({
      grant: layeredGrant(),
      op: "search",
      queryText: "bounded global target canonical",
      domains: ["mathematics"],
      limit: 8,
      worker: N28_WORKERS.algebra,
      leaseDeadlineAt: "2030-01-01T00:02:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.entries as Array<{ id: string }>).some((entry) => entry.id === "global-only")).toBe(true);
      expect(result.retrievalTrace?.globalFallback).toBe(true);
      expect((result.entries as Array<{ id: string }>).some((entry) => String(entry.id).startsWith("trap-"))).toBe(false);
    }
    expect(waveCalls).toBe(4);
  });

  it("invalid signature / missing memory.read → layeredSearchWave 调用零次", async () => {
    waveCalls = 0;
    const bad = await broker.query({
      grant: { ...layeredGrant(), signature: "0".repeat(64) },
      op: "search", queryText: "x", domains: ["mathematics"], worker: N28_WORKERS.algebra,
    });
    expect(bad.ok).toBe(false);
    expect(waveCalls).toBe(0);

    const noCap = await broker.query({
      grant: layeredGrant(["state"]),
      op: "search", queryText: "x", domains: ["mathematics"], worker: N28_WORKERS.algebra,
    });
    expect(noCap.ok).toBe(false);
    expect(waveCalls).toBe(0);
  });
});
