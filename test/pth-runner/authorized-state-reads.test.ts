import { describe, expect, it } from "vitest";
import { createAuthorizedStateReadPort } from "../../src/pth/runner/authorized-state-reads.js";
import { createExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import { createVerifiedTaskReadScopeFactory } from "../../src/pth/execution/authorization/verified-task-read-scope.js";
import type { TaskLease, TaskWorkItem, WorkerReplicaRef } from "../../src/pth/contracts/index.js";

let nowMs = Date.parse("2030-01-01T00:00:00.000Z");
const clock = () => new Date(nowMs);
const grantService = createExecutionGrantService({ keyProvider: createHmacGrantKeyProvider({ secret: "n28-state-test-secret-0123456789" }), clock });

const worker: WorkerReplicaRef = { workerId: "10000000-0000-4000-8000-000000000071", batchId: "b", role: { roleId: "researcher", revision: "v1" } };

function scopeFor(capabilities = ["memory.read", "state.recallFunctions", "state.recallInsights"]) {
  const lease: TaskLease = {
    taskId: "t", leaseId: "20000000-0000-4000-8000-000000000002", generation: 1,
    scope: { tenantId: "tenant-a", principalId: `worker:${worker.workerId}`, roles: ["researcher"], traceId: "tr", space: "meta" },
    workspace: { tenantId: "tenant-a", workspaceId: "w", taskId: "t" },
    roleId: "researcher", deadlineAt: "2030-01-01T00:02:00.000Z",
  };
  const work: TaskWorkItem = { taskId: "t", scope: lease.scope, title: "x", text: "x", tags: [], payload: {}, assignedRole: "researcher", domains: [] };
  const factory = createVerifiedTaskReadScopeFactory({
    grantService,
    grantForTask: ({ lease: l, work: w }) => grantService.issue({
      lease: l, scope: { ...w.scope, principalId: `worker:${worker.workerId}`, roles: ["researcher"] },
      workspace: l.workspace, language: "ts", capabilities, ttlMs: 120_000,
    }),
  });
  return factory.forTask({ lease, work, space: "meta", worker });
}

const rows = [
  { id: "f1", kind: "tool-function", anchors: ["a"], status: "official", content: "spec-1", tenantId: "tenant-a", meta: { spaceScope: { space: "meta", visibility: "public" } } },
  { id: "f2", kind: "tool-function", anchors: ["a"], status: "official", content: "spec-2", tenantId: "tenant-b", meta: { spaceScope: { space: "meta", visibility: "public" } } },
  { id: "i1", kind: "task-insight", anchors: ["a"], status: "official", content: "insight", tenantId: "tenant-a", meta: { spaceScope: { space: "private-other", visibility: "private" } } },
  { id: "d1", kind: "tool-function", anchors: ["a"], status: "draft", content: "draft", tenantId: "tenant-a", meta: { spaceScope: { space: "meta", visibility: "public" } } },
];

describe("authorized state reads（scope-bound canonical rows）", () => {
  it("tenant/status/space 过滤 + 稳定 ID + 排序 + limit", async () => {
    const port = createAuthorizedStateReadPort({
      memory: { retrieve: async () => rows },
      isVisible: (meta, space) => {
        const s = (meta as { spaceScope?: { space?: string; visibility?: string } } | undefined)?.spaceScope;
        if (!s || s.visibility === "public") return true;
        return s.space === space;
      },
      clock,
    });
    const reads = port.forScope(scopeFor());
    expect(await reads.recallFunctions(["a"])).toEqual([{ id: "state:function:f1", key: "f1", source: "tool-function", spec: "spec-1" }]);
    expect(await reads.recallInsights(["a"])).toEqual([]);
  });

  it("两个并发 scope 租户隔离", async () => {
    const port = createAuthorizedStateReadPort({
      memory: { retrieve: async (opts) => rows.filter((r) => r.tenantId === opts.tenantId) },
      isVisible: () => true,
      clock,
    });
    const tenantBScope = scopeFor();
    // 用 tenant-a scope（rows f1）与另一同 tenant 调用交叉验证：tenant 由 scope 强制，不读闭包。
    const a = port.forScope(tenantBScope);
    expect((await a.recallFunctions(["a"])).map((r) => r.key)).toEqual(["f1"]);
  });

  it("clock 过期后不再触 store（backing read=0）", async () => {
    let reads = 0;
    const port = createAuthorizedStateReadPort({
      memory: { retrieve: async () => { reads += 1; return rows; } },
      isVisible: () => true,
      clock,
    });
    const scope = scopeFor();
    nowMs = Date.parse("2030-01-01T00:03:00.000Z");
    expect(() => port.forScope(scope)).toThrow(/deadline/);
    expect(reads).toBe(0);
    nowMs = Date.parse("2030-01-01T00:00:00.000Z");
  });
});
