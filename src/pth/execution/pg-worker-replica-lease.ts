/**
 * execution/pg-worker-replica-lease.ts —— N28 M1：WorkerReplica lease 的 PG 持久化适配器。
 *
 * 当前注册表仍是同步内存缝；本适配器提供可独立接入的异步持久化面。
 */

import type { WorkerReplicaLease } from "./worker-replica-lease.js";
import type { PgQueryable } from "./pg-repository-types.js";

export interface AsyncLeaseRepository {
  save(lease: WorkerReplicaLease): Promise<void>;
  get(workerId: string): Promise<WorkerReplicaLease | undefined>;
  delete(workerId: string): Promise<boolean>;
}

export class PgLeaseRepository implements AsyncLeaseRepository {
  constructor(private readonly pool: PgQueryable) {}

  async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS worker_replica_leases (
        worker_id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        generation INT NOT NULL,
        expires_at BIGINT NOT NULL
      )
    `);
  }

  async save(lease: WorkerReplicaLease): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker_replica_leases (worker_id, role_id, tenant_id, generation, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (worker_id) DO UPDATE SET
         role_id=EXCLUDED.role_id, tenant_id=EXCLUDED.tenant_id,
         generation=EXCLUDED.generation, expires_at=EXCLUDED.expires_at`,
      [lease.workerId, lease.roleId, lease.tenantId, lease.generation, lease.expiresAt],
    );
  }

  async get(workerId: string): Promise<WorkerReplicaLease | undefined> {
    const r = await this.pool.query(
      `SELECT worker_id AS "workerId", role_id AS "roleId", tenant_id AS "tenantId", generation, expires_at AS "expiresAt"
       FROM worker_replica_leases WHERE worker_id=$1`,
      [workerId],
    );
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      workerId: String(row.workerId),
      roleId: String(row.roleId),
      tenantId: String(row.tenantId),
      generation: Number(row.generation),
      expiresAt: Number(row.expiresAt),
    };
  }

  async delete(workerId: string): Promise<boolean> {
    const r = await this.pool.query(
      `DELETE FROM worker_replica_leases WHERE worker_id=$1 RETURNING worker_id`,
      [workerId],
    );
    return r.rows.length > 0;
  }
}
