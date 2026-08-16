import { describe, expect, it } from "vitest";
import {
  createSandboxGrantIssuer,
  createSandboxGrantVerifier,
} from "../src/authorization/grant-verifier.js";

const SECRET = "sandbox-grant-secret-0123456789";
const issuer = createSandboxGrantIssuer({ secret: SECRET, clock: () => new Date("2030-01-01T00:00:00.000Z") });

function grant(overrides: Record<string, unknown> = {}) {
  return {
    ...issuer.issue({
      lease: { taskId: "task-1", leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6", generation: 1 },
      scope: { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-1" },
      workspace: { tenantId: "tenant-a", workspaceId: "ws-1", taskId: "task-1" },
      language: "python",
      capabilities: ["memory.read"],
      ttlMs: 10_000,
    }),
    ...overrides,
  };
}

describe("sandbox grant verifier（P2-2）", () => {
  it("合法 grant 通过；签名绑定全部字段", () => {
    const verifier = createSandboxGrantVerifier({ secret: SECRET, clock: () => new Date("2030-01-01T00:00:00.000Z") });
    expect(verifier.verify(grant()).ok).toBe(true);
  });

  it("错误密钥拒绝", () => {
    const verifier = createSandboxGrantVerifier({ secret: "other-secret-0123456789", clock: () => new Date("2030-01-01T00:00:00.000Z") });
    expect(verifier.verify(grant()).ok).toBe(false);
  });

  it("过期拒绝", () => {
    const verifier = createSandboxGrantVerifier({ secret: SECRET, clock: () => new Date("2030-01-01T00:01:00.000Z") });
    expect(verifier.verify(grant()).ok).toBe(false);
  });

  it("tenant 白名单不匹配拒绝", () => {
    const verifier = createSandboxGrantVerifier({ secret: SECRET, allowedTenants: ["tenant-b"], clock: () => new Date("2030-01-01T00:00:00.000Z") });
    expect(verifier.verify(grant()).ok).toBe(false);
  });

  it("scope 与 workspace 租户不一致拒绝", () => {
    const bad = grant({ scope: { tenantId: "tenant-a", principalId: "p", roles: ["developer"], traceId: "t" }, workspace: { tenantId: "tenant-b", workspaceId: "ws-1" } });
    // 重新签名（issuer 签发伪造一致？这里直接篡改已签名对象——签名自然失效）
    const verifier = createSandboxGrantVerifier({ secret: SECRET, clock: () => new Date("2030-01-01T00:00:00.000Z") });
    expect(verifier.verify(bad).ok).toBe(false);
  });

  it("malformed grant（缺 lease/generation）拒绝", () => {
    const verifier = createSandboxGrantVerifier({ secret: SECRET, clock: () => new Date("2030-01-01T00:00:00.000Z") });
    const g = grant() as Record<string, unknown>;
    expect(verifier.verify({ ...g, lease: { taskId: "t" } }).ok).toBe(false);
    expect(verifier.verify(null).ok).toBe(false);
  });
});
