import { describe, it, expect, vi } from "vitest";
import { createRuntimeAggregator } from "../../deploy/docker-monitor/runtime-aggregator.js";
import { createMonitorServer } from "../../deploy/docker-monitor/server.js";

/**
 * Task 4 Step 1：先写丢失事件与重复事件对账测试。
 *
 * 场景：
 *   1. 从 durable snapshot revision 1 开始（两个 stable ID 都还是 running）；
 *   2. 应用重复 delta 与乱序 delta（同 revision 更早 observedAt 必须被拒绝）；
 *   3. 故意“漏掉” terminal delta（不把 task-a 的 completed 终态作为 delta 推送）；
 *   4. 用 durable revision 2 snapshot 对账；
 *   5. 断言最终每个 stable ID 只存在一条 revision 2 记录，没有任何重复行。
 */

const NOW = 3000;
const TASK_A_ID = "task:tenant-a:t1:attempt:2";
const TASK_B_ID = "intake-run:tenant-a:run-9";

function makeFreshness(sourceObservedAt: number, collectedAt: number) {
  return {
    sourceObservedAt,
    collectedAt,
    expectedIntervalMs: 5000,
    staleAfterMs: 15000,
  };
}

function makePthInterval(
  id: string,
  sourceVersion: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    kind: id.startsWith("task:") ? "task" : "intake-run",
    workMode: id.startsWith("task:") ? "run" : "intake",
    label: id,
    status: "running",
    sourceVersion,
    startAt: 1000,
    endAt: null,
    freshness: makeFreshness(1200, 1250),
    tenantId: "tenant-a",
    ...overrides,
  };
}

function makeSnapshot(
  snapshotId: string,
  collectedAt: number,
  intervals: Array<ReturnType<typeof makePthInterval>>,
) {
  return {
    snapshotId,
    collectedAt,
    window: { from: 0, to: collectedAt },
    scope: { mode: "local-admin" as const, tenantId: "tenant-a" },
    summary: {
      activeTasks: 0,
      queuedTasks: 0,
      workers: 0,
      idleWorkers: 0,
      activeIntakeRuns: 0,
      activeOptimizeWorks: 0,
      activeRunWorks: 0,
      alerts: 0,
    },
    intervals,
    resources: [],
    sources: [],
    warnings: [],
  };
}

function makeUpsertDelta(
  payload: ReturnType<typeof makePthInterval>,
  seq: number,
  observedAt: number,
) {
  return {
    streamEpoch: "epoch-1",
    seq,
    observedAt,
    type: "interval.upsert" as const,
    payload,
  };
}

describe("docker-monitor createRuntimeAggregator", () => {
  it("snapshot rev1 → 重复/乱序 delta → 缺 terminal delta → durable rev2 对账后每个 stable ID 只剩一条 revision 2", () => {
    const agg = createRuntimeAggregator({ clock: () => NOW });

    const rev1TaskA = makePthInterval(TASK_A_ID, "1");
    const rev1TaskB = makePthInterval(TASK_B_ID, "1");
    agg.reconcileSnapshot(makeSnapshot("snap-rev1", 2000, [rev1TaskA, rev1TaskB]));

    expect(agg.getIntervals()).toHaveLength(2);

    // 重复 delta：与快照相同 revision/相同身份，允许被幂等接受。
    agg.applyDelta(makeUpsertDelta(
      makePthInterval(TASK_A_ID, "1", {
        status: "running",
        startAt: 1000,
        endAt: null,
        freshness: makeFreshness(1300, 1350),
      }),
      1,
      1350,
    ));

    // 乱序 delta：同 revision 但 observedAt 更早 → 必须拒绝，不得覆盖已有状态。
    agg.applyDelta(makeUpsertDelta(
      makePthInterval(TASK_A_ID, "1", {
        status: "completed",
        startAt: 1000,
        endAt: 900,
        freshness: makeFreshness(900, 950),
      }),
      2,
      950,
    ));

    // 缺 terminal delta：这里故意不推送 task-a 的 completed 终态，
    // 直接进入 durable snapshot revision 2 对账。
    const rev2TaskA = makePthInterval(TASK_A_ID, "2", {
      status: "completed",
      startAt: 1000,
      endAt: 2200,
      freshness: makeFreshness(2200, 2250),
    });
    const rev2TaskB = makePthInterval(TASK_B_ID, "2", {
      status: "completed",
      startAt: 1000,
      endAt: 2100,
      freshness: makeFreshness(2100, 2150),
    });
    agg.reconcileSnapshot(makeSnapshot("snap-rev2", 2500, [rev2TaskA, rev2TaskB]));

    const finalRows = agg.getIntervals();
    expect(finalRows).toHaveLength(2);

    const taskARows = finalRows.filter((row) => row.id === TASK_A_ID);
    const taskBRows = finalRows.filter((row) => row.id === TASK_B_ID);
    expect(taskARows).toHaveLength(1);
    expect(taskBRows).toHaveLength(1);

    expect(taskARows[0]?.sourceVersion).toBe("2");
    expect(taskBRows[0]?.sourceVersion).toBe("2");

    // 对账快照是 authoritative：漏掉的 terminal delta 必须被 durable rev2 纠正。
    expect(taskARows[0]?.status).toBe("completed");
    expect(taskARows[0]?.endAt).toBe(2200);
    expect(taskBRows[0]?.status).toBe("completed");
    expect(taskBRows[0]?.endAt).toBe(2100);

    // 无重复行：按 id 分组后每组恰好一条。
    const byId = new Map(finalRows.map((row) => [row.id, row]));
    expect(byId.size).toBe(finalRows.length);
  });

  it("PTH-down：来源标记失败后先 stale 再 disconnected，恢复 snapshot 后 fresh 且 lane 更新", () => {
    let now = 0;
    const agg = createRuntimeAggregator({ clock: () => now });

    agg.reconcileSnapshot(makeSnapshot("snap-1", 1000, [
      makePthInterval(TASK_A_ID, "1"),
    ]));

    expect(agg.getSources()[0]?.state).toBe("fresh");

    // PTH 不可用：旧 snapshot 保留（lane 冻结），但来源状态按 stale 阈值恶化。
    now = 16_001;
    agg.markSourceFailure("pth-timeline");
    expect(agg.getSources()[0]?.state).toBe("stale");
    expect(agg.getIntervals()[0]?.sourceVersion).toBe("1");

    now = 31_001;
    expect(agg.getSources()[0]?.state).toBe("disconnected");

    // 恢复：durable snapshot 直接 reconcile，无需页面刷新即可回到 fresh + 新 revision。
    agg.reconcileSnapshot(makeSnapshot("snap-2", 32_000, [
      makePthInterval(TASK_A_ID, "2", {
        status: "completed",
        endAt: 31_500,
        freshness: makeFreshness(31_500, 31_600),
      }),
    ]));
    expect(agg.getSources()[0]?.state).toBe("fresh");
    expect(agg.getIntervals()).toHaveLength(1);
    expect(agg.getIntervals()[0]?.sourceVersion).toBe("2");
    expect(agg.getIntervals()[0]?.status).toBe("completed");
  });

  it("窗口内 tombstone：snapshot 删除的 ID 会被 remove，旧 revision delta 不得复活", () => {
    const agg = createRuntimeAggregator({ clock: () => NOW });
    const taskA = makePthInterval(TASK_A_ID, "1");
    const taskB = makePthInterval(TASK_B_ID, "1");

    agg.reconcileSnapshot(makeSnapshot("snap-1", 2000, [taskA, taskB]));
    expect(agg.getIntervals()).toHaveLength(2);

    // durable snapshot 只保留 task B → task A 在当前窗口内 tombstone。
    agg.reconcileSnapshot(makeSnapshot("snap-2", 2500, [taskB]));

    expect(agg.getIntervals()).toHaveLength(1);
    expect(agg.getIntervals()[0]?.id).toBe(TASK_B_ID);

    const events = agg.drainEvents();
    const removeEvents = events.filter((ev) => ev.type === "interval.remove");
    expect(removeEvents).toHaveLength(1);
    expect(removeEvents[0]?.payload.id).toBe(TASK_A_ID);

    // 旧 revision delta 不能把 tombstone 区间复活。
    const result = agg.applyDelta(makeUpsertDelta(
      makePthInterval(TASK_A_ID, "1"),
      99,
      NOW,
    ));
    expect(result.accepted).toBe(false);
    expect(agg.getIntervals()).toHaveLength(1);
  });
});

const DOCKER_FULL_ID = "deadbeef0000000000000000000000000000000000000000000000000000000000";

function makeDockerMock() {
  return {
    getContainers: vi.fn(async () => [{
      Id: DOCKER_FULL_ID,
      Names: ["/svc"],
      Image: "alpine:3.20",
      State: "running",
      Status: "Up 2 hours",
      Ports: [],
    }]),
    inspectContainer: vi.fn(async () => ({
      Id: DOCKER_FULL_ID,
      Name: "/svc",
      Created: "2026-01-01T00:00:00.000Z",
      State: {
        StartedAt: "2026-01-01T00:00:01.000Z",
        FinishedAt: "0001-01-01T00:00:00.000Z",
        Running: true,
      },
      Config: { Image: "alpine:3.20" },
    })),
    getContainerStats: vi.fn(async () => ({
      cpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 10_000, online_cpus: 4 },
      memory_stats: { usage: 1_000_000, limit: 4_000_000 },
      networks: { eth0: { rx_bytes: 100, tx_bytes: 200 } },
    })),
  };
}

function makePthPage(collectedAt: number, intervals: Array<ReturnType<typeof makePthInterval>>) {
  return {
    intervals,
    nextCursor: null,
    window: { from: 0, to: collectedAt },
    scope: { mode: "local-admin" as const, tenantId: "tenant-a" },
    sourceObservedAt: collectedAt,
    collectedAt,
  };
}

describe("docker-monitor PTH-down 降级与恢复（server 合并）", () => {
  it("PTH 不可用时 Docker 样本继续、PTH lane 冻结 stale，恢复 snapshot reconcile 免刷新；且绝不调写路由", async () => {
    let now = 0;
    let pthDown = false;
    const pthFetch = vi.fn(async (url: string, init: { method: string }) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/api/v1/observe/timeline");
      expect(init.method).toBe("GET");
      if (pthDown) throw new Error("pth down");
      return new Response(JSON.stringify(makePthPage(now, [
        makePthInterval(TASK_A_ID, pthDown ? "0" : now === 0 ? "1" : "2", {
          freshness: makeFreshness(now, now),
        }),
      ])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const monitor = createMonitorServer({
      port: 0,
      intervalMs: 2000,
      docker: makeDockerMock(),
      clock: () => now,
      pth: {
        endpoint: "http://127.0.0.1:4000",
        token: "s3cr3t-runtime-observer-token",
        fetchImpl: pthFetch,
      },
    });

    // 初始：Docker sample + PTH lane 都在，pth-timeline fresh。
    await monitor.collectOnce();
    let snap = monitor.snapshot();
    expect(snap.samples).toHaveLength(1);
    expect(snap.intervals.some((iv) => iv.id === TASK_A_ID)).toBe(true);
    expect(snap.sources.find((s) => s.source === "pth-timeline")?.state).toBe("fresh");

    // PTH down：Docker 采样继续；PTH lane 冻结；来源进入 stale。
    pthDown = true;
    now = 16_001;
    await monitor.collectOnce();
    snap = monitor.snapshot();
    expect(snap.samples.some((s) => s.ts === now)).toBe(true);
    expect(snap.intervals.some((iv) => iv.id === TASK_A_ID)).toBe(true);
    expect(snap.sources.find((s) => s.source === "pth-timeline")?.state).toBe("stale");

    // 持续不可用 → disconnected。
    now = 31_001;
    await monitor.collectOnce();
    snap = monitor.snapshot();
    expect(snap.sources.find((s) => s.source === "pth-timeline")?.state).toBe("disconnected");
    expect(snap.samples.some((s) => s.ts === now)).toBe(true);

    // 恢复：同一 monitor 实例上 durable snapshot reconcile，无需刷新页面。
    pthDown = false;
    now = 32_000;
    await monitor.collectOnce();
    snap = monitor.snapshot();
    expect(snap.sources.find((s) => s.source === "pth-timeline")?.state).toBe("fresh");
    const taskA = snap.intervals.find((iv) => iv.id === TASK_A_ID);
    expect(taskA?.sourceVersion).toBe("2");
    expect(snap.samples.some((s) => s.ts === now)).toBe(true);

    // 安全边界：monitor 只通过 pth-client 调 GET /api/v1/observe/timeline，绝不调 PTH 写路由。
    for (const call of pthFetch.mock.calls) {
      expect(call[1].method).toBe("GET");
      expect(String(call[0]).includes("/api/v1/observe/timeline")).toBe(true);
    }
  });
});
