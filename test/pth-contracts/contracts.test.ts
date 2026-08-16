import { describe, expect, it } from "vitest";
import {
  isExecutionGrantStructurallyValid,
  isExecutionRequestStructurallyValid,
  isTaskLeaseStructurallyValid,
  isTaskOutcomeStructurallyValid,
  isTenantScopeStructurallyValid,
  isWorkspaceRefStructurallyValid,
  type ExecutionGrant,
  type ExecutionRequest,
  type TaskLease,
  type TaskOutcome,
  type TenantScope,
  type WorkspaceRef,
} from "../../src/pth/contracts/index.js";

const scope: TenantScope = {
  tenantId: "tenant-a",
  principalId: "worker:origin",
  roles: ["origin"],
  traceId: "trace-001",
};

const workspace: WorkspaceRef = {
  tenantId: "tenant-a",
  workspaceId: "ws-opaque-001",
  taskId: "task-001",
};

const leaseRef = {
  taskId: "task-001",
  leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6",
  generation: 1,
} as const;

describe("pth contracts: identity", () => {
  it("models a server-derived tenant scope", () => {
    expect(isTenantScopeStructurallyValid(scope)).toBe(true);
    expect(scope.principalId).toBe("worker:origin");
    expect(scope.roles).toEqual(["origin"]);
  });

  it("rejects scope with missing or empty authority fields", () => {
    expect(isTenantScopeStructurallyValid({ ...scope, tenantId: "" })).toBe(false);
    expect(isTenantScopeStructurallyValid({ ...scope, principalId: "" })).toBe(false);
    expect(isTenantScopeStructurallyValid({ ...scope, roles: [] })).toBe(false);
    expect(isTenantScopeStructurallyValid({ ...scope, traceId: "" })).toBe(false);
  });

  it("models an opaque workspace reference", () => {
    expect(isWorkspaceRefStructurallyValid(workspace)).toBe(true);
    expect(workspace.workspaceId).toBe("ws-opaque-001");
  });
});

describe("pth contracts: tasking", () => {
  const lease: TaskLease = {
    taskId: "task-001",
    leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6",
    scope,
    workspace,
    roleId: "developer",
    generation: 1,
    deadlineAt: "2030-01-01T00:00:10.000Z",
  };

  it("models a capability lease, not a predictable string", () => {
    expect(isTaskLeaseStructurallyValid(lease)).toBe(true);
    expect(lease.generation).toBe(1);
  });

  it("rejects stale or malformed leases", () => {
    expect(isTaskLeaseStructurallyValid({ ...lease, leaseId: "py-1" })).toBe(false);
    expect(isTaskLeaseStructurallyValid({ ...lease, generation: 0 })).toBe(false);
    expect(isTaskLeaseStructurallyValid({ ...lease, deadlineAt: "not-a-date" })).toBe(false);
  });

  it("validates outcomes only against their committed lease", () => {
    const outcome: TaskOutcome = {
      lease: leaseRef,
      status: "completed",
      result: { ok: true },
      artifacts: [{ kind: "file", uri: "file:///tmp/out" }],
      traceId: scope.traceId,
    };
    expect(isTaskOutcomeStructurallyValid(outcome)).toBe(true);
    expect(isTaskOutcomeStructurallyValid({ ...outcome, status: "flying" })).toBe(false);
    expect(isTaskOutcomeStructurallyValid({ ...outcome, lease: { ...leaseRef, generation: 0 } })).toBe(false);
  });
});

describe("pth contracts: execution", () => {
  const grant: ExecutionGrant = {
    grantId: "0c4a2c7d-800c-4e3e-8a0b-6d3e3474627d",
    nonce: "8efab84f-e946-4b84-a49e-e1d08cc38a50",
    lease: leaseRef,
    scope,
    workspace,
    language: "python",
    capabilities: ["memory.read"],
    issuedAt: "2030-01-01T00:00:00.000Z",
    deadlineAt: "2030-01-01T00:00:10.000Z",
  };

  it("models scope/lease/language-bound grants without creating authority", () => {
    expect(isExecutionGrantStructurallyValid(grant)).toBe(true);
    expect(grant.workspace.workspaceId).toBe("ws-opaque-001");
    expect(grant.lease.generation).toBe(1);
  });

  it("rejects malformed cross-boundary grant values", () => {
    expect(isExecutionGrantStructurallyValid({ grantId: "not-a-uuid", scope, workspace: { tenantId: "tenant-b" } })).toBe(false);
    expect(isExecutionGrantStructurallyValid({ ...grant, nonce: "" })).toBe(false);
    expect(isExecutionGrantStructurallyValid({ ...grant, capabilities: [42] })).toBe(false);
    expect(isExecutionGrantStructurallyValid({ ...grant, deadlineAt: "2030-01-01T00:00:00.000Z" })).toBe(false);
  });

  it("validates execution requests bound to a scope and workspace", () => {
    const request: ExecutionRequest = {
      scope,
      workspace,
      language: "ts",
      program: "return 1;",
      timeoutMs: 30_000,
      maxStdout: 1024,
      maxStderr: 1024,
    };
    expect(isExecutionRequestStructurallyValid(request)).toBe(true);
    expect(isExecutionRequestStructurallyValid({ ...request, timeoutMs: 0 })).toBe(false);
    expect(isExecutionRequestStructurallyValid({ ...request, maxStdout: -1 })).toBe(false);
  });
});
