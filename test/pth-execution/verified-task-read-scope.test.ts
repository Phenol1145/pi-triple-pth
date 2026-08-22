import { describe, expect, it } from "vitest";
import { assertVerifiedTaskReadScope, createVerifiedTaskReadScopeFactory } from "../../src/pth/execution/authorization/verified-task-read-scope.js";
import { createExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import type { ExecutionGrant, TaskLease, TaskWorkItem, WorkerReplicaRef } from "@away_from/pth-contracts";

let nowMs = Date.parse("2030-01-01T00:00:00.000Z");
const clock = () => new Date(nowMs);

const worker: WorkerReplicaRef = {
  workerId: "10000000-0000-4000-8000-000000000061",
  batchId: "batch-n28",
  role: { roleId: "researcher", revision: "rev-v1" },
};

const lease: TaskLease = {
  taskId: "task-n28",
  leaseId: "20000000-0000-4000-8000-000000000001",
  generation: 1,
  scope: { tenantId: "tenant-a", principalId: `worker:${worker.workerId}`, roles: ["researcher"], traceId: "trace-n28", space: "meta" },
  workspace: { tenantId: "tenant-a", workspaceId: "ws-n28", taskId: "task-n28" },
  roleId: "researcher",
  deadlineAt: "2030-01-01T00:02:00.000Z",
};

const work: TaskWorkItem = {
  taskId: "task-n28",
  scope: lease.scope,
  title: "n28",
  text: "n28",
  tags: [],
  payload: {},
  assignedRole: "researcher",
  domains: ["mathematics"],
};

function grantService() {
  return createExecutionGrantService({
    keyProvider: createHmacGrantKeyProvider({ secret: "n28-feasibility-test-secret-0123456789" }),
    clock,
  });
}

function issueGrant(svc: ReturnType<typeof grantService>, overrides: Partial<Parameters<ReturnType<typeof grantService>["issue"]>[0]> = {}): ExecutionGrant {
  return svc.issue({
    lease,
    scope: { ...lease.scope, principalId: `worker:${worker.workerId}`, roles: ["researcher"] },
    workspace: lease.workspace,
    language: "ts",
    capabilities: ["memory.read", "memory.query"],
    ttlMs: 120_000,
    ...overrides,
  });
}

describe("VerifiedTaskReadScope（一次性真实 verify + 私密 mint）", () => {
  it("valid：forTask mint 冻结信封，字段与服务端盖章一致", () => {
    const svc = grantService();
    const factory = createVerifiedTaskReadScopeFactory({ grantService: svc, grantForTask: () => issueGrant(svc) });
    const scope = factory.forTask({ lease, work, space: "meta", worker });
    expect(scope).toMatchObject({
      tenantId: "tenant-a",
      space: "meta",
      principalId: `worker:${worker.workerId}`,
      worker,
      lease: { taskId: "task-n28", leaseId: lease.leaseId, generation: 1 },
    });
    expect(scope.capabilities).toContain("memory.read");
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.worker)).toBe(true);
    assertVerifiedTaskReadScope(scope, {
      tenantId: "tenant-a", space: "meta", principalId: `worker:${worker.workerId}`,
      workerId: worker.workerId, taskId: "task-n28", leaseId: lease.leaseId, generation: 1,
    }, { clock });
  });

  it("bad signature / expired / missing capability 全部拒绝", () => {
    const svc = grantService();
    const factory = createVerifiedTaskReadScopeFactory({ grantService: svc, grantForTask: () => issueGrant(svc) });
    const valid = issueGrant(svc);
    expect(() => createVerifiedTaskReadScopeFactory({
      grantService: svc,
      grantForTask: () => ({ ...valid, signature: "0".repeat(64) }),
    }).forTask({ lease, work, space: "meta", worker })).toThrow(/signature/);

    const staleGrant = issueGrant(svc);   // issued at t0（deadline 00:02）
    nowMs = Date.parse("2030-01-01T00:03:00.000Z");
    expect(() => createVerifiedTaskReadScopeFactory({
      grantService: svc,
      grantForTask: () => staleGrant,
    }).forTask({ lease, work, space: "meta", worker })).toThrow(/expired|deadline|verify/);
    nowMs = Date.parse("2030-01-01T00:00:00.000Z");

    expect(() => createVerifiedTaskReadScopeFactory({
      grantService: svc,
      grantForTask: () => issueGrant(svc, { capabilities: ["state"] }),
    }).forTask({ lease, work, space: "meta", worker })).toThrow(/memory.read/);
  });

  it("tenant/space/principal/generation mismatch 拒绝", () => {
    const svc = grantService();
    const mk = (overrides: Partial<Parameters<ReturnType<typeof grantService>["issue"]>[0]> = {}) =>
      createVerifiedTaskReadScopeFactory({ grantService: svc, grantForTask: () => issueGrant(svc, overrides) });
    expect(() => mk({ scope: { ...lease.scope, tenantId: "tenant-b", principalId: `worker:${worker.workerId}` } }).forTask({ lease, work, space: "meta", worker })).toThrow(/tenant/);
    expect(() => mk({ scope: { ...lease.scope, space: "other", principalId: `worker:${worker.workerId}` } }).forTask({ lease, work, space: "meta", worker })).toThrow(/space/);
    expect(() => mk({ scope: { ...lease.scope, principalId: "worker:someone-else" } }).forTask({ lease, work, space: "meta", worker })).toThrow(/principal|worker/);
    expect(() => mk({ lease: { ...lease, generation: 2 } }).forTask({ lease, work, space: "meta", worker })).toThrow(/generation|lease/);
  });

  it("grant TTL 超过 lease → deadlineAt 取 lease 更早值；clock 越过后廉价断言失败且不再 verify", () => {
    const svc = grantService();
    const verifySpy = { count: 0 };
    const rawVerify = svc.verify.bind(svc);
    const spiedSvc = { ...svc, verify: (g: unknown, o?: Parameters<typeof svc.verify>[1]) => { verifySpy.count += 1; return rawVerify(g, o); } };
    const factory = createVerifiedTaskReadScopeFactory({
      grantService: spiedSvc,
      grantForTask: () => issueGrant(svc, { ttlMs: 120_000 }),
    });
    const scope = factory.forTask({ lease, work, space: "meta", worker });
    expect(scope.deadlineAt).toBe(lease.deadlineAt);
    expect(verifySpy.count).toBe(1);

    nowMs = Date.parse("2030-01-01T00:02:01.000Z");
    expect(() => assertVerifiedTaskReadScope(scope, { workerId: worker.workerId }, { clock })).toThrow(/deadline/);
    expect(verifySpy.count).toBe(1);   // 廉价断言不重放 verify（replay nonce 不消耗）
  });

  it("post-construction mutation 被冻结拒绝", () => {
    const svc = grantService();
    const factory = createVerifiedTaskReadScopeFactory({ grantService: svc, grantForTask: () => issueGrant(svc) });
    const scope = factory.forTask({ lease, work, space: "meta", worker });
    expect(() => { (scope as { tenantId: string }).tenantId = "tenant-b"; }).toThrow();
    expect(() => { (scope.capabilities as string[]).push("forged"); }).toThrow();
  });

  it("verifyBrokerGrant：唯一对外真实 verify 入口；principal 不绑定 worker → 拒绝", () => {
    const svc = grantService();
    const factory = createVerifiedTaskReadScopeFactory({ grantService: svc, grantForTask: () => issueGrant(svc) });
    const grant = issueGrant(svc);
    const scope = factory.verifyBrokerGrant({ grant, worker, leaseDeadlineAt: lease.deadlineAt });
    expect(scope.deadlineAt).toBe(lease.deadlineAt);
    expect(() => factory.verifyBrokerGrant({ grant: { ...grant, signature: "bad" }, worker, leaseDeadlineAt: lease.deadlineAt })).toThrow(/signature/);
    expect(() => factory.verifyBrokerGrant({
      grant: issueGrant(svc, { scope: { ...lease.scope, principalId: "developer" } }),
      worker,
      leaseDeadlineAt: lease.deadlineAt,
    })).toThrow(/principal|worker/);
  });
});
