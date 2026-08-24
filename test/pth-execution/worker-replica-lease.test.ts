import { describe, it, expect } from "vitest";
import { WorkerReplicaLeaseRegistry } from "../../src/pth/execution/worker-replica-lease.js";

describe("N28 WorkerReplica Lease Registry", () => {
  it("acquire/renew/release 内存语义", () => {
    const reg = new WorkerReplicaLeaseRegistry();
    const lease = { workerId: "w1", roleId: "coder", tenantId: "t", generation: 1, expiresAt: Date.now() + 1000 };
    expect(reg.acquire(lease).ok).toBe(true);
    expect(reg.get("w1")?.roleId).toBe("coder");
    expect(reg.renew("w1", Date.now() + 2000)).toBe(true);
    expect(reg.release("w1")).toBe(true);
    expect(reg.get("w1")).toBeUndefined();
  });

  it("未到期不可重复 acquire", () => {
    const reg = new WorkerReplicaLeaseRegistry();
    const lease = { workerId: "w1", roleId: "coder", tenantId: "t", generation: 1, expiresAt: Date.now() + 1000 };
    expect(reg.acquire(lease).ok).toBe(true);
    expect(reg.acquire({ ...lease, generation: 2 }).ok).toBe(false);
  });
});
