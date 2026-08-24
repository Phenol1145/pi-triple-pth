/**
 * execution/pg-memory-region-registry.ts —— N28 M2：MemoryRegion 责任区的 PG 持久化适配器。
 *
 * Region 只存引用/成员，不复制正文；selector 以 JSONB 保存。
 */

import type { MemoryRegion } from "./memory-region-registry.js";
import type { PgQueryable } from "./pg-repository-types.js";

export interface AsyncRegionRepository {
  save(region: MemoryRegion): Promise<void>;
  get(regionId: string): Promise<MemoryRegion | undefined>;
  list(tenantId?: string): Promise<MemoryRegion[]>;
  delete(regionId: string): Promise<boolean>;
}

export interface AsyncRegionMemberRepository {
  add(regionId: string, entryId: string): Promise<boolean>;
  list(regionId: string): Promise<string[]>;
  remove(regionId: string, entryId: string): Promise<boolean>;
}

function parseSelector(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return { raw: value };
    }
  }
  return (value ?? {}) as Record<string, unknown>;
}

export class PgRegionRepository implements AsyncRegionRepository {
  constructor(private readonly pool: PgQueryable) {}

  async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS memory_regions (
        region_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        selector JSONB NOT NULL,
        owner_role_id TEXT NOT NULL,
        weight DOUBLE PRECISION NOT NULL
      )
    `);
  }

  async save(region: MemoryRegion): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_regions (region_id, tenant_id, selector, owner_role_id, weight)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (region_id) DO UPDATE SET
         tenant_id=EXCLUDED.tenant_id, selector=EXCLUDED.selector,
         owner_role_id=EXCLUDED.owner_role_id, weight=EXCLUDED.weight`,
      [region.id, region.tenantId, JSON.stringify(region.selector), region.ownerRoleId, region.weight],
    );
  }

  async get(regionId: string): Promise<MemoryRegion | undefined> {
    const r = await this.pool.query(
      `SELECT region_id AS "id", tenant_id AS "tenantId", selector, owner_role_id AS "ownerRoleId", weight
       FROM memory_regions WHERE region_id=$1`,
      [regionId],
    );
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      tenantId: String(row.tenantId),
      selector: parseSelector(row.selector),
      ownerRoleId: String(row.ownerRoleId),
      weight: Number(row.weight),
    };
  }

  async list(tenantId?: string): Promise<MemoryRegion[]> {
    const r = tenantId
      ? await this.pool.query(
          `SELECT region_id AS "id", tenant_id AS "tenantId", selector, owner_role_id AS "ownerRoleId", weight
           FROM memory_regions WHERE tenant_id=$1 ORDER BY region_id`,
          [tenantId],
        )
      : await this.pool.query(
          `SELECT region_id AS "id", tenant_id AS "tenantId", selector, owner_role_id AS "ownerRoleId", weight
           FROM memory_regions ORDER BY region_id`,
        );
    return r.rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenantId),
      selector: parseSelector(row.selector),
      ownerRoleId: String(row.ownerRoleId),
      weight: Number(row.weight),
    }));
  }

  async delete(regionId: string): Promise<boolean> {
    const r = await this.pool.query(
      `DELETE FROM memory_regions WHERE region_id=$1 RETURNING region_id`,
      [regionId],
    );
    return r.rows.length > 0;
  }
}

export class PgRegionMemberRepository implements AsyncRegionMemberRepository {
  constructor(private readonly pool: PgQueryable) {}

  async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS memory_region_members (
        region_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        PRIMARY KEY (region_id, entry_id)
      )
    `);
  }

  async add(regionId: string, entryId: string): Promise<boolean> {
    await this.pool.query(
      `INSERT INTO memory_region_members (region_id, entry_id)
       VALUES ($1,$2)
       ON CONFLICT (region_id, entry_id) DO NOTHING`,
      [regionId, entryId],
    );
    return true;
  }

  async list(regionId: string): Promise<string[]> {
    const r = await this.pool.query(
      `SELECT entry_id AS "entryId" FROM memory_region_members WHERE region_id=$1 ORDER BY entry_id`,
      [regionId],
    );
    return r.rows.map((row) => String(row.entryId));
  }

  async remove(regionId: string, entryId: string): Promise<boolean> {
    const r = await this.pool.query(
      `DELETE FROM memory_region_members WHERE region_id=$1 AND entry_id=$2 RETURNING entry_id`,
      [regionId, entryId],
    );
    return r.rows.length > 0;
  }
}
