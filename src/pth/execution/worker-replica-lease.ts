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

export interface LeaseRepository {
  save(lease: WorkerReplicaLease): void;
  get(workerId: string): WorkerReplicaLease | undefined;
  delete(workerId: string): boolean;
}

export class InMemoryLeaseRepository implements LeaseRepository {
  private readonly leases = new Map<string, WorkerReplicaLease>();
  save(lease: WorkerReplicaLease): void { this.leases.set(lease.workerId, lease); }
  get(workerId: string): WorkerReplicaLease | undefined { return this.leases.get(workerId); }
  delete(workerId: string): boolean { return this.leases.delete(workerId); }
}

export class WorkerReplicaLeaseRegistry {
  private readonly memory = new InMemoryLeaseRepository();
  private readonly repo: LeaseRepository;

  constructor(repo?: LeaseRepository) {
    this.repo = repo ?? this.memory;
  }

  acquire(lease: WorkerReplicaLease): { ok: true } | { ok: false; reason: string } {
    const existing = this.repo.get(lease.workerId);
    if (existing && existing.expiresAt > Date.now()) {
      return { ok: false, reason: `worker ${lease.workerId} lease 仍有效` };
    }
    this.repo.save(lease);
    return { ok: true };
  }

  renew(workerId: string, expiresAt: number): boolean {
    const lease = this.repo.get(workerId);
    if (!lease || lease.expiresAt <= Date.now()) return false;
    this.repo.save({ ...lease, expiresAt });
    return true;
  }

  release(workerId: string): boolean {
    return this.repo.delete(workerId);
  }

  get(workerId: string): WorkerReplicaLease | undefined {
    const lease = this.repo.get(workerId);
    return lease && lease.expiresAt > Date.now() ? lease : undefined;
  }
}
