import { describe, expect, it } from "vitest";
import { createKnowledgeBroker } from "../../src/pth/execution/knowledge-broker.js";
import { createExecutionGrantService, createMemoryReplayGuard } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import type { ExecutionGrant } from "../../src/pth/contracts/index.js";

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
    const r = await broker.query({ grant: makeGrant(), op: "query", sql: "SELECT 1" });
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
