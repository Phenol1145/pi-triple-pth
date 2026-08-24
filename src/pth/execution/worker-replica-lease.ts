/**
 * execution/worker-replica-lease.ts —— N28 生产化：WorkerReplica 持久 lease 骨架（内存实现）。
 *
 * 生产化计划 M1：replica 身份与 lease 持久化。本模块先提供确定性内存语义，
 * PG 持久化由后续迁移替换。
 */

export interface WorkerReplicaLease {
  workerId: string;
  roleId: string;
  tenantId: string;
  generation: number;
  expiresAt: number;
}

export class WorkerReplicaLeaseRegistry {
  private readonly leases = new Map<string, WorkerReplicaLease>();

  acquire(lease: WorkerReplicaLease): { ok: true } | { ok: false; reason: string } {
    const existing = this.leases.get(lease.workerId);
    if (existing && existing.expiresAt > Date.now()) {
      return { ok: false, reason: `worker ${lease.workerId} lease 仍有效` };
    }
    this.leases.set(lease.workerId, lease);
    return { ok: true };
  }

  renew(workerId: string, expiresAt: number): boolean {
    const lease = this.leases.get(workerId);
    if (!lease || lease.expiresAt <= Date.now()) return false;
    this.leases.set(workerId, { ...lease, expiresAt });
    return true;
  }

  release(workerId: string): boolean {
    return this.leases.delete(workerId);
  }

  get(workerId: string): WorkerReplicaLease | undefined {
    const lease = this.leases.get(workerId);
    return lease && lease.expiresAt > Date.now() ? lease : undefined;
  }
}
