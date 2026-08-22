import { describe, expect, it } from "vitest";
import {
  buildRuntimeIntervalId,
  computeFreshnessState,
  defaultFreshnessThresholds,
  parseRuntimeIntervalId,
  validateResourceSample,
  validateRuntimeDelta,
  validateRuntimeInterval,
  validateRuntimeSnapshot,
  type FreshnessStamp,
  type ResourceSample,
  type RuntimeInterval,
  type RuntimeSnapshot,
} from "@away_from/pth-contracts";

const freshness: FreshnessStamp = {
  sourceObservedAt: 1200,
  collectedAt: 1250,
  expectedIntervalMs: 5000,
  staleAfterMs: 10000,
};

const interval: RuntimeInterval = {
  id: "task:tenant-a:t1:attempt:2",
  parentId: "job:tenant-a:j1",
  tenantId: "tenant-a",
  kind: "task",
  workMode: "run",
  label: "compile theorem",
  status: "running",
  startAt: 1000,
  endAt: null,
  sourceVersion: "2",
  freshness,
  taskId: "t1",
  workerId: "w1",
  roleId: "lean4-prover",
  traceId: "tr1",
};

describe("runtime observation DTO: interval invariants", () => {
  it("accepts a running task interval with a null endAt", () => {
    expect(validateRuntimeInterval(interval).ok).toBe(true);
  });

  it("rejects an interval whose endAt precedes startAt", () => {
    expect(validateRuntimeInterval({ ...interval, endAt: 999 }).ok).toBe(false);
  });

  it("rejects negative and non-finite startAt", () => {
    expect(validateRuntimeInterval({ ...interval, startAt: -1 }).ok).toBe(false);
    expect(validateRuntimeInterval({ ...interval, startAt: Number.NaN }).ok).toBe(false);
    expect(validateRuntimeInterval({ ...interval, startAt: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  it("rejects cross-tenant parents", () => {
    expect(validateRuntimeInterval({ ...interval, parentId: "job:tenant-b:j1" }).ok).toBe(false);
    expect(validateRuntimeInterval({ ...interval, parentId: "job:tenant-a:j1" }).ok).toBe(true);
  });

  it("rejects an id whose embedded tenant does not match tenantId", () => {
    expect(validateRuntimeInterval({ ...interval, id: "task:tenant-b:t1:attempt:2" }).ok).toBe(false);
  });

  it("rejects malformed stable ids and malformed parent ids", () => {
    expect(validateRuntimeInterval({ ...interval, id: "job:tenant-a:j1" }).ok).toBe(false);
    expect(validateRuntimeInterval({ ...interval, id: "task:tenant-a:" }).ok).toBe(false);
    expect(validateRuntimeInterval({ ...interval, parentId: "not-a-stable-id" }).ok).toBe(false);
  });

  it("rejects unknown workMode and unknown status", () => {
    expect(validateRuntimeInterval({ ...interval, workMode: "sprint" }).ok).toBe(false);
    expect(validateRuntimeInterval({ ...interval, status: "flying" }).ok).toBe(false);
  });

  it("keeps workMode untouched when status changes", () => {
    const completed = { ...interval, status: "completed" as const, endAt: 2000 };
    expect(completed.workMode).toBe("run");
    expect(validateRuntimeInterval(completed).ok).toBe(true);
  });
});

describe("runtime observation DTO: resource sample invariants", () => {
  const sample: ResourceSample = {
    ts: 2000,
    targetKind: "container",
    targetId: "container-a",
    cpuPercent: null,
    rssBytes: null,
    heapUsedBytes: null,
    netRxBytes: null,
    netTxBytes: null,
    source: "docker",
    freshness: { ...freshness, sourceObservedAt: 1900, collectedAt: 1950 },
  };

  it("accepts and preserves null CPU/RSS/Heap/Network metrics", () => {
    const result = validateResourceSample(sample);
    expect(result.ok).toBe(true);
    expect(sample.cpuPercent).toBeNull();
    expect(sample.rssBytes).toBeNull();
    expect(sample.heapUsedBytes).toBeNull();
    expect(sample.netRxBytes).toBeNull();
    expect(sample.netTxBytes).toBeNull();
  });

  it("rejects non-finite metrics instead of synthesizing values", () => {
    expect(validateResourceSample({ ...sample, cpuPercent: Number.NaN }).ok).toBe(false);
    expect(validateResourceSample({ ...sample, rssBytes: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateResourceSample({ ...sample, heapUsedBytes: Number.NEGATIVE_INFINITY }).ok).toBe(false);
    expect(validateResourceSample({ ...sample, netRxBytes: Number.NaN }).ok).toBe(false);
    expect(validateResourceSample({ ...sample, netTxBytes: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  it("rejects negative sample timestamps", () => {
    expect(validateResourceSample({ ...sample, ts: -1 }).ok).toBe(false);
  });
});

describe("runtime observation DTO: stable id helpers", () => {
  it("returns the same id for the same input", () => {
    expect(buildRuntimeIntervalId("task", "t1:attempt:2", "tenant-a")).toBe(
      buildRuntimeIntervalId("task", "t1:attempt:2", "tenant-a"),
    );
  });

  it("embeds the tenant segment in tenant-owned ids", () => {
    const a = buildRuntimeIntervalId("task", "t1", "tenant-a");
    const b = buildRuntimeIntervalId("task", "t1", "tenant-b");
    expect(a).toBe("task:tenant-a:t1");
    expect(b).toBe("task:tenant-b:t1");
    expect(a).not.toBe(b);
  });

  it("round-trips through parseRuntimeIntervalId", () => {
    expect(parseRuntimeIntervalId("task:tenant-a:t1:attempt:2")).toEqual({
      kind: "task",
      tenantId: "tenant-a",
      localId: "t1:attempt:2",
    });
    expect(parseRuntimeIntervalId("service:docker-monitor:main")).toEqual({
      kind: "service",
      localId: "docker-monitor:main",
    });
  });
});

describe("runtime observation DTO: freshness contract", () => {
  const stamp: FreshnessStamp = {
    sourceObservedAt: 1_000,
    collectedAt: 1_100,
    expectedIntervalMs: 5_000,
    staleAfterMs: 10_000,
  };
  const thresholds = defaultFreshnessThresholds(stamp);

  it("derives deterministic thresholds from the stamp", () => {
    expect(thresholds).toEqual({ laggingAfterMs: 5_000, staleAfterMs: 10_000, disconnectedAfterMs: 30_000 });
  });

  it("classifies the four states with an injected clock", () => {
    expect(computeFreshnessState(stamp, 6_000, thresholds)).toBe("fresh");
    expect(computeFreshnessState(stamp, 11_000, thresholds)).toBe("lagging");
    expect(computeFreshnessState(stamp, 31_000, thresholds)).toBe("stale");
    expect(computeFreshnessState(stamp, 31_001, thresholds)).toBe("disconnected");
  });

  it("is deterministic for identical injected clocks", () => {
    expect(computeFreshnessState(stamp, 31_001, thresholds)).toBe(computeFreshnessState(stamp, 31_001, thresholds));
  });

  it("uses the injected clock instead of process time", () => {
    expect(computeFreshnessState(stamp, 6_000, thresholds)).toBe("fresh");
    expect(computeFreshnessState(stamp, 32_000, thresholds)).toBe("disconnected");
  });
});

describe("runtime observation DTO: snapshot and delta validation", () => {
  const snapshot: RuntimeSnapshot = {
    snapshotId: "snap-1",
    collectedAt: 2000,
    window: { from: 0, to: 2000 },
    scope: { mode: "local-admin", tenantId: "tenant-a" },
    summary: {
      activeTasks: 1,
      queuedTasks: 0,
      workers: 1,
      idleWorkers: 0,
      activeIntakeRuns: 0,
      activeOptimizeWorks: 0,
      activeRunWorks: 1,
      alerts: 0,
    },
    intervals: [interval],
    resources: [],
    sources: [],
    warnings: [],
  };

  it("accepts a well-formed snapshot", () => {
    expect(validateRuntimeSnapshot(snapshot).ok).toBe(true);
  });

  it("rejects a snapshot whose window is reversed", () => {
    expect(validateRuntimeSnapshot({ ...snapshot, window: { from: 2000, to: 0 } }).ok).toBe(false);
  });

  it("rejects deltas whose payload does not match their type", () => {
    expect(validateRuntimeDelta({
      streamEpoch: "epoch-1",
      seq: 1,
      observedAt: 2000,
      type: "interval.upsert",
      payload: snapshot,
    }).ok).toBe(false);
    expect(validateRuntimeDelta({
      streamEpoch: "epoch-1",
      seq: 1,
      observedAt: 2000,
      type: "interval.upsert",
      payload: interval,
    }).ok).toBe(true);
  });
});
