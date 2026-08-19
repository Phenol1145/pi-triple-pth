import { describe, expect, it } from "vitest";
import {
  MEMORY_TYPES,
  N28_FEASIBILITY_BUDGET,
  checkResponsibilityCapacity,
  type MemoryRegion,
  type MemoryResponsibility,
  type WorkerReplicaRef,
} from "../../src/pth/contracts/cognitive-responsibility.js";

const worker: WorkerReplicaRef = {
  workerId: "10000000-0000-4000-8000-000000000001",
  batchId: "batch-a",
  role: { roleId: "researcher", revision: "role-sha256:fixture-v1" },
};

const regions: MemoryRegion[] = [
  { regionId: "region:algebra", revision: 1, selector: { domains: ["algebra"] }, estimatedWeight: 50 },
  { regionId: "region:numerical", revision: 1, selector: { anchorsAny: ["numerical"] }, estimatedWeight: 30 },
];

const responsibilities: MemoryResponsibility[] = [
  { workerId: worker.workerId, regionId: "region:algebra", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 },
  { workerId: worker.workerId, regionId: "region:numerical", regionRevision: 1, kind: "overlap", priority: 1, epoch: 1 },
];

describe("cognitive responsibility contract", () => {
  it("MEMORY_TYPES 排序后为五类共享记忆", () => {
    expect([...MEMORY_TYPES].sort()).toEqual(["index", "log", "setting", "skill", "wiki"]);
  });

  it("accepts a worker load that is inside every responsibility limit", () => {
    expect(checkResponsibilityCapacity(worker, regions, responsibilities, N28_FEASIBILITY_BUDGET.responsibility)).toEqual({
      ok: true,
      usage: { regions: 2, primaryWeight: 50, secondaryWeight: 30 },
    });
  });

  it("rejects responsibility expansion above the primary weight", () => {
    const overloaded = regions.map((region) => region.regionId === "region:algebra" ? { ...region, estimatedWeight: 81 } : region);
    expect(checkResponsibilityCapacity(worker, overloaded, responsibilities, N28_FEASIBILITY_BUDGET.responsibility)).toMatchObject({
      ok: false,
      reason: "primary-weight",
    });
  });

  it("counts overlap and fallback against the same secondary ceiling", () => {
    const withFallback = [
      ...responsibilities,
      { workerId: worker.workerId, regionId: "region:fallback", regionRevision: 1, kind: "fallback" as const, priority: 2, epoch: 1 },
    ];
    const withRegion = [...regions, { regionId: "region:fallback", revision: 1, selector: { anchorsAny: ["shared"] }, estimatedWeight: 11 }];
    expect(checkResponsibilityCapacity(worker, withRegion, withFallback, N28_FEASIBILITY_BUDGET.responsibility)).toMatchObject({
      ok: false,
      reason: "secondary-weight",
    });
  });

  it("rejects a responsibility that names another worker", () => {
    const forged = [{ ...responsibilities[0]!, workerId: "10000000-0000-4000-8000-000000000099" }];
    expect(checkResponsibilityCapacity(worker, regions, forged, N28_FEASIBILITY_BUDGET.responsibility)).toMatchObject({
      ok: false,
      reason: "worker-mismatch",
    });
  });
});
