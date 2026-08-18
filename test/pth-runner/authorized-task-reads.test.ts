import { describe, expect, it, vi } from "vitest";
import { createAuthorizedTaskReadFactory, expandTaskReadGrantCapabilities } from "../../src/pth/runner/authorized-task-reads.js";
import { createExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import { createVerifiedTaskReadScopeFactory } from "../../src/pth/execution/authorization/verified-task-read-scope.js";
import type { PendingRetrievalTrace, TaskLease, TaskWorkItem, WorkerReplicaRef } from "../../src/pth/contracts/index.js";

const clock = () => new Date("2030-01-01T00:00:00.000Z");
const grantService = createExecutionGrantService({ keyProvider: createHmacGrantKeyProvider({ secret: "n28-task-read-test-secret-0123456789" }), clock });
const worker: WorkerReplicaRef = { workerId: "10000000-0000-4000-8000-000000000081", batchId: "b", role: { roleId: "researcher", revision: "v1" } };
const allCaps = ["memory.read", "memory.query", "state.recallFunctions", "state.recallInsights", "skills.list", "skills.get"];

function makeInput(capabilities: string[] = allCaps) {
  const lease: TaskLease = {
    taskId: "t", leaseId: "20000000-0000-4000-8000-000000000003", generation: 1,
    scope: { tenantId: "tenant-a", principalId: `worker:${worker.workerId}`, roles: ["researcher"], traceId: "tr", space: "meta" },
    workspace: { tenantId: "tenant-a", workspaceId: "w", taskId: "t" },
    roleId: "researcher", deadlineAt: "2030-01-01T00:02:00.000Z",
  };
  const work: TaskWorkItem = { taskId: "t", scope: lease.scope, title: "x", text: "x", tags: [], payload: {}, assignedRole: "researcher", domains: [] };
  const factory = createVerifiedTaskReadScopeFactory({
    grantService,
    grantForTask: ({ lease: l, work: w }) => grantService.issue({
      lease: l, scope: { ...w.scope, principalId: `worker:${worker.workerId}`, roles: ["researcher"], space: "meta" },
      workspace: l.workspace, language: "ts", capabilities, ttlMs: 120_000,
    }),
  });
  const authorization = factory.forTask({ lease, work, space: "meta", worker });
  return { lease, work, authorization };
}

describe("authorized task read factory", () => {
  it("expandTaskReadGrantCapabilities：family 展开冻结（memory.query 不自动发）", () => {
    expect(expandTaskReadGrantCapabilities(["memory", "state", "skills", "tasks"])).toEqual([
      "memory.read", "skills.get", "skills.list", "state.recallFunctions", "state.recallInsights", "tasks",
    ]);
    expect(expandTaskReadGrantCapabilities(["memory.query"])).toEqual(["memory.query"]);
  });

  it("全部 7 个 read surface 映射到 queryVerified / state / skills 端口", async () => {
    const pending: PendingRetrievalTrace = {
      directorySnapshotId: "md-1", workerId: worker.workerId, queryFingerprint: "q-1",
      waves: [{ wave: 0, regionIds: [], candidateCount: 1, visibleCount: 1, selectedCount: 1, scannedCount: 1, completeForQuery: true, reason: "primary" }],
      globalFallback: false, omitted: {}, status: "found",
    };
    const brokerCalls: Array<{ op: string; body: unknown }> = [];
    const broker = {
      queryVerified: vi.fn(async (_authorization: unknown, body: { op?: string } & Record<string, unknown>) => {
        brokerCalls.push({ op: String(body.op ?? "?"), body });
        if (body.op === "search") return { ok: true, entries: [{ id: "e1", content: "x" }], retrievalTrace: pending, queryFingerprint: "q-1" };
        if (body.op === "get") return { ok: true, entry: { id: body.id, content: "full" } };
        if (body.op === "query") return { ok: true, rows: [{ id: "r1", meta: {} }, { id: "r2", meta: {} }] };
        return { ok: false, status: 400, error: "bad op" };
      }),
    };
    const { lease, work, authorization } = makeInput();
    const factory = createAuthorizedTaskReadFactory({
      broker: broker as never,
      state: { forScope: () => ({
        recallFunctions: async () => [{ id: "state:function:f", key: "f", source: "tool-function", spec: { a: 1 } }],
        recallInsights: async () => [{ id: "state:insight:i", content: "insight" }],
      }) },
      skills: { forScope: () => ({
        list: async () => [{ id: "skill:a", anchor: "a", whenToUse: "w", effect: "e", status: "official" }],
        get: async (id: string) => ({ id, tenantId: "tenant-a", kind: `skill:${id}`, anchors: [], content: "full skill", status: "official", meta: {} }),
      }) },
      clock,
    });
    const reads = factory.forTask({ lease, work, space: "meta", worker, authorization });
    const retrieve = await reads.retrieveMemory({ anchors: ["mathematics"] });
    expect(retrieve.entries.map((e) => e.id)).toEqual(["e1"]);
    expect(retrieve.trace).toBe(pending);
    expect((await reads.getMemory("e1"))?.id).toBe("e1");
    expect((await reads.queryMemory("SELECT 1"))?.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect((await reads.recallFunctions(["a"]))[0]?.key).toBe("f");
    expect((await reads.recallInsights(["a"]))[0]?.content).toBe("insight");
    expect((await reads.listSkills()).map((s) => s.id)).toEqual(["skill:a"]);
    expect((await reads.getSkill("a"))?.id).toBe("a");
    expect(brokerCalls.map((c) => c.op)).toEqual(["search", "get", "query"]);
  });

  it("missing capability → 对应 backing 调用 0", async () => {
    const broker = { queryVerified: vi.fn(async () => ({ ok: false, status: 403, error: "forbidden" })) };
    const { lease, work, authorization } = makeInput(["memory.read"]);
    const reads = createAuthorizedTaskReadFactory({
      broker: broker as never,
      state: { forScope: () => ({ recallFunctions: async () => [], recallInsights: async () => [] }) },
      skills: { forScope: () => ({ list: async () => [], get: async () => undefined }) },
      clock,
    }).forTask({ lease, work, space: "meta", worker, authorization });
    await expect(reads.queryMemory("SELECT 1")).rejects.toThrow(/memory.query/);
    await expect(reads.recallFunctions(["a"])).rejects.toThrow(/recallFunctions/);
    await expect(reads.listSkills()).rejects.toThrow(/skills.list/);
    expect(broker.queryVerified).not.toHaveBeenCalled();
  });
});
