import { describe, it, expect } from "vitest";
import { PgLeaseRepository } from "../../src/pth/execution/pg-worker-replica-lease.js";
import { PgRegionRepository, PgRegionMemberRepository } from "../../src/pth/execution/pg-memory-region-registry.js";
import { PgCognitiveLedgerOutbox } from "../../src/pth/execution/pg-task-cognitive-ledger-outbox.js";
import type { PgQueryable } from "../../src/pth/execution/pg-repository-types.js";
import type { WorkerReplicaLease } from "../../src/pth/execution/worker-replica-lease.js";
import type { MemoryRegion } from "../../src/pth/execution/memory-region-registry.js";
import type { CognitiveLedgerEvent } from "../../src/pth/execution/task-cognitive-ledger-outbox.js";

function fakeLeasePool(): PgQueryable {
  const rows: Array<Record<string, unknown>> = [];
  return {
    async query(text: string, params?: unknown[]) {
      if (text.startsWith("CREATE TABLE")) return { rows: [] };
      if (text.startsWith("INSERT INTO worker_replica_leases")) {
        const row = {
          workerId: params![0], roleId: params![1], tenantId: params![2],
          generation: params![3], expiresAt: params![4],
        };
        const idx = rows.findIndex((r) => r.workerId === row.workerId);
        if (idx >= 0) rows[idx] = row; else rows.push(row);
        return { rows: [] };
      }
      if (text.startsWith("SELECT worker_id")) {
        const row = rows.find((r) => r.workerId === params![0]);
        return { rows: row ? [row] : [] };
      }
      if (text.startsWith("DELETE FROM worker_replica_leases")) {
        const idx = rows.findIndex((r) => r.workerId === params![0]);
        if (idx < 0) return { rows: [] };
        return { rows: rows.splice(idx, 1) };
      }
      return { rows: [] };
    },
  };
}

function fakeRegionPool(): PgQueryable {
  const regions: Array<Record<string, unknown>> = [];
  const members: Array<Record<string, unknown>> = [];
  return {
    async query(text: string, params?: unknown[]) {
      if (text.startsWith("CREATE TABLE")) return { rows: [] };
      if (text.startsWith("INSERT INTO memory_regions")) {
        const row = {
          id: params![0], tenantId: params![1], selector: params![2],
          ownerRoleId: params![3], weight: params![4],
        };
        const idx = regions.findIndex((r) => r.id === row.id);
        if (idx >= 0) regions[idx] = row; else regions.push(row);
        return { rows: [] };
      }
      if (text.includes("FROM memory_regions WHERE region_id=$1")) {
        const row = regions.find((r) => r.id === params![0]);
        return { rows: row ? [row] : [] };
      }
      if (text.includes("FROM memory_regions WHERE tenant_id=$1")) {
        return { rows: regions.filter((r) => r.tenantId === params![0]) };
      }
      if (text.includes("FROM memory_regions ORDER BY region_id")) {
        return { rows: [...regions] };
      }
      if (text.startsWith("DELETE FROM memory_regions")) {
        const idx = regions.findIndex((r) => r.id === params![0]);
        if (idx < 0) return { rows: [] };
        return { rows: regions.splice(idx, 1) };
      }
      if (text.startsWith("INSERT INTO memory_region_members")) {
        members.push({ regionId: params![0], entryId: params![1] });
        return { rows: [] };
      }
      if (text.startsWith("SELECT entry_id AS \"entryId\" FROM memory_region_members")) {
        return { rows: members.filter((m) => m.regionId === params![0]).map((m) => ({ entryId: m.entryId })) };
      }
      if (text.startsWith("DELETE FROM memory_region_members")) {
        const idx = members.findIndex((m) => m.regionId === params![0] && m.entryId === params![1]);
        if (idx < 0) return { rows: [] };
        return { rows: members.splice(idx, 1) };
      }
      return { rows: [] };
    },
  };
}

function fakeOutboxPool(): PgQueryable {
  const rows: Array<Record<string, unknown>> = [];
  return {
    async query(text: string, params?: unknown[]) {
      if (text.startsWith("CREATE TABLE")) return { rows: [] };
      if (text.startsWith("INSERT INTO cognitive_ledger_outbox")) {
        rows.push({
          id: params![0], type: params![1], taskId: params![2], workerId: params![3],
          payload: params![4], at: params![5],
        });
        return { rows: [] };
      }
      if (text.startsWith("DELETE FROM cognitive_ledger_outbox")) {
        return { rows: rows.splice(0, rows.length) };
      }
      if (text.startsWith("SELECT id, type, task_id AS \"taskId\", worker_id AS \"workerId\", payload, at")) {
        return { rows: [...rows] };
      }
      return { rows: [] };
    },
  };
}

describe("N28 PG 生产化适配器", () => {
  it("WorkerReplica lease 可持久化 save/get/delete", async () => {
    const repo = new PgLeaseRepository(fakeLeasePool());
    await repo.ensureTable();
    const lease: WorkerReplicaLease = {
      workerId: "w1", roleId: "analyst", tenantId: "t1", generation: 2, expiresAt: 999,
    };
    await repo.save(lease);
    await expect(repo.get("w1")).resolves.toEqual(lease);
    await expect(repo.delete("w1")).resolves.toBe(true);
    await expect(repo.get("w1")).resolves.toBeUndefined();
  });

  it("MemoryRegion 与成员关系可持久化", async () => {
    const pool = fakeRegionPool();
    const regions = new PgRegionRepository(pool);
    const members = new PgRegionMemberRepository(pool);
    await regions.ensureTable();
    await members.ensureTable();
    const region: MemoryRegion = {
      id: "r1", tenantId: "t1", selector: { kind: "project", tags: ["pth"] }, ownerRoleId: "analyst", weight: 0.6,
    };
    await regions.save(region);
    await expect(regions.get("r1")).resolves.toEqual(region);
    await expect(regions.list("t1")).resolves.toEqual([region]);
    await members.add("r1", "entry-a");
    await members.add("r1", "entry-b");
    await expect(members.list("r1")).resolves.toEqual(["entry-a", "entry-b"]);
    await expect(members.remove("r1", "entry-a")).resolves.toBe(true);
    await expect(members.list("r1")).resolves.toEqual(["entry-b"]);
  });

  it("认知账本 outbox 可 append/pending/drain", async () => {
    const repo = new PgCognitiveLedgerOutbox(fakeOutboxPool());
    await repo.ensureTable();
    const e1: CognitiveLedgerEvent = {
      id: "e1", type: "budget-reset", taskId: "task1", workerId: "w1",
      payload: { budget: 10 }, at: 100,
    };
    const e2: CognitiveLedgerEvent = {
      id: "e2", type: "factor-recorded", taskId: "task1", workerId: "w1",
      payload: { factor: "focus" }, at: 200,
    };
    await repo.append(e1);
    await repo.append(e2);
    await expect(repo.pending()).resolves.toEqual([e1, e2]);
    await expect(repo.drain()).resolves.toEqual([e1, e2]);
    await expect(repo.pending()).resolves.toEqual([]);
  });
});
