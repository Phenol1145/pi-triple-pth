import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createExecutionGrantService,
  createMemoryReplayGuard,
} from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import type {
  ExecutionGrant,
  ExecutionLanguage,
  TenantScope,
  WorkspaceRef,
} from "@away_from/pth-contracts";

const key = createHmacGrantKeyProvider({ secret: "test-signing-key-0123456789abcdef" });
const otherKey = createHmacGrantKeyProvider({ secret: "other-signing-key-0123456789abcdef" });

const scope: TenantScope = { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-1" };
const workspace: WorkspaceRef = { tenantId: "tenant-a", workspaceId: "ws-opaque-1", taskId: "task-1" };
const lease = { taskId: "task-1", leaseId: randomUUID(), generation: 1 };

function issue(): ExecutionGrant {
  const service = createExecutionGrantService({
    keyProvider: key,
    clock: () => new Date("2030-01-01T00:00:00.000Z"),
  });
  return service.issue({
    lease,
    scope,
    workspace,
    language: "python" as ExecutionLanguage,
    capabilities: ["memory.read"],
    ttlMs: 10_000,
  });
}

describe("execution grant service（P2-1）", () => {
  it("issue 产出签名 grant：绑定 lease/scope/workspace/language/capability/generation/deadline", () => {
    const grant = issue();
    expect(grant.grantId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(grant.nonce).toMatch(/^[0-9a-f-]{36}$/i);
    expect(grant.lease).toEqual(lease);
    expect(grant.scope).toEqual(scope);
    expect(grant.workspace).toEqual(workspace);
    expect(grant.language).toBe("python");
    expect(grant.capabilities).toEqual(["memory.read"]);
    expect(grant.signature).toBeTruthy();
    expect(new Date(grant.deadlineAt).getTime() - new Date(grant.issuedAt).getTime()).toBe(10_000);
  });

  it("verify：正确密钥 + 正确 generation 通过", () => {
    const grant = issue();
    const service = createExecutionGrantService({ keyProvider: key, clock: () => new Date("2030-01-01T00:00:00.000Z") });
    const r = service.verify(grant, { leaseGeneration: 1 });
    expect(r.ok).toBe(true);
  });

  it("verify：错误密钥拒绝", () => {
    const grant = issue();
    const service = createExecutionGrantService({ keyProvider: otherKey });
    expect(service.verify(grant, { leaseGeneration: 1 }).ok).toBe(false);
  });

  it("verify：过期拒绝（deadline 早于当前时间）", () => {
    const grant = issue();
    const service = createExecutionGrantService({
      keyProvider: key,
      clock: () => new Date("2030-01-01T00:01:00.000Z"),
    });
    expect(service.verify(grant, { leaseGeneration: 1 }).ok).toBe(false);
  });

  it("verify：generation 不匹配拒绝", () => {
    const grant = issue();
    const service = createExecutionGrantService({ keyProvider: key });
    expect(service.verify(grant, { leaseGeneration: 2 }).ok).toBe(false);
  });

  it("verify：重放拒绝（同 nonce 二次使用）", () => {
    const grant = issue();
    const replay = createMemoryReplayGuard({ clock: () => new Date("2030-01-01T00:00:00.000Z") });
    const service = createExecutionGrantService({ keyProvider: key, replayGuard: replay, clock: () => new Date("2030-01-01T00:00:00.000Z") });
    expect(service.verify(grant, { leaseGeneration: 1 }).ok).toBe(true);
    expect(service.verify(grant, { leaseGeneration: 1 }).ok).toBe(false);
  });

  it("verify：篡改 payload 后签名失效", () => {
    const grant = issue();
    const service = createExecutionGrantService({ keyProvider: key });
    const tampered = { ...grant, capabilities: ["memory.write"] };
    expect(service.verify(tampered, { leaseGeneration: 1 }).ok).toBe(false);
  });
});
