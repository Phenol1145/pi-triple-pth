import { describe, it, expect } from "vitest";
import { createUiState } from "../../deploy/docker-monitor/ui-state.js";

/**
 * N30 Task 5 Step 1：纯 UI 状态模型测试。
 *
 * 覆盖：15m/1h/custom 窗口、intake/optimize/run 过滤、pause/resume、
 * 选中区间、层级折叠、stale 来源着色、事件 replay；
 * 并断言同一 windowStart/windowEnd 对象喂给两个图（getWindow 始终返回同一引用）。
 */

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const HOUR = 3_600_000;
const QUARTER = 900_000;

function makeFreshness(sourceObservedAt: number, collectedAt = sourceObservedAt) {
  return {
    sourceObservedAt,
    collectedAt,
    expectedIntervalMs: 5000,
    staleAfterMs: 15000,
  };
}

function makeInterval(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const kind = id.split(":")[0] ?? "task";
  return {
    id,
    parentId: overrides.parentId as string | undefined,
    kind,
    workMode: Object.prototype.hasOwnProperty.call(overrides, "workMode")
      ? overrides.workMode
      : "run",
    label: id,
    status: overrides.status ?? "running",
    sourceVersion: overrides.sourceVersion ?? "1",
    startAt: overrides.startAt ?? NOW - 600_000,
    endAt: overrides.endAt ?? null,
    freshness: overrides.freshness ?? makeFreshness(NOW - 1000),
    tenantId: "tenant-a",
    workerId: overrides.workerId ?? "w1",
    roleId: overrides.roleId ?? "lean4-prover",
    batchId: overrides.batchId ?? "b1",
    traceId: overrides.traceId ?? "tr1",
    attempt: overrides.attempt ?? 1,
    ...overrides,
  };
}

function makeSample(
  ts: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ts,
    targetKind: "container",
    targetId: "c1",
    cpuPercent: 10,
    rssBytes: 1000,
    heapUsedBytes: 2000,
    memoryLimitBytes: 4000,
    netRxBytes: 100,
    netTxBytes: 200,
    health: "healthy",
    source: "docker",
    freshness: makeFreshness(ts, ts),
    ...overrides,
  };
}

function makeSnapshot(
  collectedAt: number,
  intervals: Array<Record<string, unknown>>,
  samples: Array<Record<string, unknown>> = [],
  sources: Array<Record<string, unknown>> = [
    {
      source: "docker",
      state: "fresh",
      lastSuccessAt: collectedAt - 1000,
      lastAttemptAt: collectedAt - 1000,
      expectedIntervalMs: 2000,
      staleAfterMs: 6000,
      consecutiveFailures: 0,
    },
  ],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    snapshotId: `snap-${collectedAt}`,
    collectedAt,
    window: { from: collectedAt - HOUR, to: collectedAt },
    scope: { mode: "local-admin", tenantId: "tenant-a" },
    summary: {
      activeTasks: 1,
      queuedTasks: 0,
      workers: 1,
      idleWorkers: 0,
      activeIntakeRuns: 0,
      activeOptimizeWorks: 0,
      activeRunWorks: 0,
      alerts: 0,
    },
    intervals,
    samples,
    sources,
    warnings: [],
    ...overrides,
  };
}

function snapState(
  state: ReturnType<typeof createUiState>,
): Record<string, unknown> {
  return {
    window: { ...state.getWindow() },
    preset: state.getPreset?.(),
    paused: state.isPaused(),
    selectedIntervalId: state.getSelectedIntervalId(),
    collapsed: [...(state.getCollapsed?.() ?? [])].sort(),
    workModeFilter: [...(state.getWorkModeFilter?.() ?? [])].sort(),
    intervals: state.getIntervals().map((iv) => ({ id: iv.id, sourceVersion: iv.sourceVersion, status: iv.status })),
    visibleIntervalIds: state.getVisibleIntervals().map((iv) => iv.id).sort(),
    samples: state.getSamples().map((s) => ({ ts: s.ts, cpuPercent: s.cpuPercent })),
    sources: state.getSources().map((s) => s.source).sort(),
  };
}

describe("docker-monitor ui-state", () => {
  it("15m/1h/custom 窗口共享同一 window 对象引用", () => {
    const state = createUiState({ clock: () => NOW, defaultPreset: "1h" });
    const shared = state.getWindow();

    expect(shared).toEqual({ from: NOW - HOUR, to: NOW });

    state.setPreset("15m");
    expect(state.getWindow()).toBe(shared);
    expect(shared).toEqual({ from: NOW - QUARTER, to: NOW });

    state.setCustomWindow(NOW - 300_000, NOW - 60_000);
    expect(state.getWindow()).toBe(shared);
    expect(shared).toEqual({ from: NOW - 300_000, to: NOW - 60_000 });

    // 非法窗口必须被拒绝，共享对象保持不变。
    expect(() => state.setCustomWindow(NOW, NOW - 1)).toThrow();
    expect(shared).toEqual({ from: NOW - 300_000, to: NOW - 60_000 });
  });

  it("intake/optimize/run 过滤只作用于带 workMode 的业务区间，service lane 始终可见", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot(NOW, [
      makeInterval("service:docker:1", { kind: "service", workMode: undefined, startAt: NOW - 500_000 }),
      makeInterval("job:tenant-a:j1", { kind: "job", workMode: undefined, startAt: NOW - 600_000 }),
      makeInterval("task:tenant-a:t1:attempt:1", {
        parentId: "job:tenant-a:j1", kind: "task", workMode: "run", startAt: NOW - 500_000,
      }),
      makeInterval("intake-run:tenant-a:i1", {
        parentId: "task:tenant-a:t1:attempt:1", kind: "intake-run", workMode: "intake", startAt: NOW - 400_000,
      }),
      makeInterval("optimizer-work:tenant-a:o1", {
        parentId: "task:tenant-a:t1:attempt:1", kind: "optimizer-work", workMode: "optimize", startAt: NOW - 300_000,
      }),
    ]));

    expect(state.getVisibleIntervals().map((iv) => iv.id).sort()).toEqual([
      "intake-run:tenant-a:i1",
      "job:tenant-a:j1",
      "optimizer-work:tenant-a:o1",
      "service:docker:1",
      "task:tenant-a:t1:attempt:1",
    ]);

    state.setWorkModeFilter(["intake"]);
    const visible = state.getVisibleIntervals().map((iv) => iv.id).sort();
    // service 是中立基础设施 lane，不受 workMode 过滤；其余只有 intake 自身可见。
    expect(visible).toEqual(["intake-run:tenant-a:i1", "service:docker:1"]);

    state.setWorkModeFilter(["run", "optimize"]);
    expect(state.getVisibleIntervals().map((iv) => iv.id).sort()).toEqual([
      "optimizer-work:tenant-a:o1",
      "service:docker:1",
      "task:tenant-a:t1:attempt:1",
    ]);

    // 清空过滤恢复全部。
    state.setWorkModeFilter([]);
    expect(state.getVisibleIntervals()).toHaveLength(5);
  });

  it("pause 冻结窗口不停止事件摄入；resume 请求重取 snapshot 并跳到当前窗口", () => {
    let now = NOW;
    const state = createUiState({ clock: () => now });
    state.applySnapshot(makeSnapshot(now, []));
    state.setPreset("15m");
    const before = { ...state.getWindow() };

    state.setPaused(true);
    expect(state.isPaused()).toBe(true);

    // 时间前进，暂停期间窗口不自动平移。
    now = NOW + 120_000;
    state.applyEvent({ type: "heartbeat", seq: 1, payload: { source: "aggregator", freshness: makeFreshness(now) } });
    expect(state.getWindow()).toEqual(before);

    // 暂停期间事件仍被摄入。
    state.applyEvent({
      type: "interval.upsert",
      seq: 2,
      payload: makeInterval("task:tenant-a:t1:attempt:1", { startAt: NOW - 60_000 }),
    });
    expect(state.getIntervals()).toHaveLength(1);

    state.resume();
    expect(state.isPaused()).toBe(false);
    expect(state.isRefetchRequired()).toBe(true);
    expect(state.getWindow()).toEqual({ from: now - QUARTER, to: now });
  });

  it("选中区间与层级折叠", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot(NOW, [
      makeInterval("service:docker:1", { kind: "service", workMode: undefined, startAt: NOW - 600_000 }),
      makeInterval("job:tenant-a:j1", { kind: "job", workMode: undefined, startAt: NOW - 600_000 }),
      makeInterval("task:tenant-a:t1:attempt:1", {
        parentId: "job:tenant-a:j1", kind: "task", workMode: "run", startAt: NOW - 500_000,
      }),
      makeInterval("intake-run:tenant-a:i1", {
        parentId: "task:tenant-a:t1:attempt:1", kind: "intake-run", workMode: "intake", startAt: NOW - 400_000,
      }),
    ]));

    state.selectInterval("task:tenant-a:t1:attempt:1");
    expect(state.getSelectedIntervalId()).toBe("task:tenant-a:t1:attempt:1");
    expect(state.getSelectedInterval()?.kind).toBe("task");
    state.clearSelection();
    expect(state.getSelectedIntervalId()).toBeNull();

    // 折叠 job 后，task 与 intake 都不出现在 lane 行中。
    const lanesBefore = state.getGanttLanes();
    expect(lanesBefore.map((lane) => lane.id).sort()).toEqual([
      "intake-run:tenant-a:i1",
      "job:tenant-a:j1",
      "service:docker:1",
      "task:tenant-a:t1:attempt:1",
    ]);
    expect(lanesBefore.find((lane) => lane.id === "task:tenant-a:t1:attempt:1")?.depth).toBe(1);
    expect(lanesBefore.find((lane) => lane.id === "intake-run:tenant-a:i1")?.depth).toBe(2);

    state.toggleCollapse("job:tenant-a:j1");
    expect(state.isCollapsed("job:tenant-a:j1")).toBe(true);
    const lanesAfter = state.getGanttLanes();
    expect(lanesAfter.map((lane) => lane.id).sort()).toEqual([
      "job:tenant-a:j1",
      "service:docker:1",
    ]);

    state.toggleCollapse("job:tenant-a:j1");
    expect(state.isCollapsed("job:tenant-a:j1")).toBe(false);
    expect(state.getGanttLanes()).toHaveLength(4);
  });

  it("stale 来源着色：按 renderedAt 计算每个来源状态，并暴露受影响区间", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot(NOW, [
      makeInterval("task:tenant-a:t1:attempt:1", {
        workMode: "run",
        freshness: makeFreshness(NOW - 20_000),
      }),
    ], [], [
      {
        source: "docker",
        state: "fresh",
        lastSuccessAt: NOW - 1000,
        lastAttemptAt: NOW - 1000,
        expectedIntervalMs: 2000,
        staleAfterMs: 6000,
        consecutiveFailures: 0,
      },
      {
        source: "pth-timeline",
        state: "fresh",
        lastSuccessAt: NOW - 20_000,
        lastAttemptAt: NOW - 20_000,
        expectedIntervalMs: 5000,
        staleAfterMs: 15000,
        consecutiveFailures: 0,
      },
    ]));

    // 20 秒前成功 → 已经超过 staleAfterMs=15s，pth-timeline 判定 stale。
    const renderedAt = NOW;
    const states = state.getSourceStates(renderedAt);
    const docker = states.find((s) => s.source === "docker");
    const pth = states.find((s) => s.source === "pth-timeline");
    expect(docker?.state).toBe("fresh");
    expect(pth?.state).toBe("stale");

    // 该 PTH 区间应被标记为 stale 着色。
    const staleIntervals = state.getStaleIntervals(renderedAt);
    expect(staleIntervals.map((iv) => iv.id)).toEqual(["task:tenant-a:t1:attempt:1"]);

    // 来源未超时则不 stale（renderedAt=lastSuccess+4s < expectedInterval=5s）。
    const okStates = state.getSourceStates(NOW - 16_000);
    expect(okStates.find((s) => s.source === "pth-timeline")?.state).toBe("fresh");
  });

  it("事件 replay：同一事件序列重放得到一致状态", () => {
    const events: Array<Record<string, unknown>> = [
      {
        type: "snapshot",
        seq: 0,
        streamEpoch: "epoch-1",
        payload: makeSnapshot(NOW, [
          makeInterval("job:tenant-a:j1", { kind: "job", workMode: undefined, startAt: NOW - 600_000 }),
          makeInterval("task:tenant-a:t1:attempt:1", {
            parentId: "job:tenant-a:j1", kind: "task", workMode: "run", startAt: NOW - 500_000,
          }),
        ], [makeSample(NOW - 1000)]),
      },
      {
        type: "interval.upsert",
        seq: 1,
        streamEpoch: "epoch-1",
        payload: makeInterval("task:tenant-a:t1:attempt:1", {
          parentId: "job:tenant-a:j1",
          kind: "task",
          workMode: "run",
          startAt: NOW - 500_000,
          endAt: NOW - 1000,
          status: "completed",
          sourceVersion: "2",
        }),
      },
      {
        type: "resource-sample",
        seq: 2,
        streamEpoch: "epoch-1",
        payload: makeSample(NOW - 500, { cpuPercent: 42 }),
      },
      {
        type: "interval.remove",
        seq: 3,
        streamEpoch: "epoch-1",
        payload: { id: "task:tenant-a:t1:attempt:1", source: "pth-timeline", removedAt: NOW - 900 },
      },
    ];

    const first = createUiState({ clock: () => NOW });
    for (const ev of events) first.applyEvent(ev);

    const second = createUiState({ clock: () => NOW });
    for (const ev of events) second.applyEvent(ev);

    expect(snapState(first)).toEqual(snapState(second));

    // 最终状态：task 已被 remove，只剩 job + 两个资源样本。
    expect(first.getIntervals().map((iv) => iv.id)).toEqual(["job:tenant-a:j1"]);
    expect(first.getSamples()).toHaveLength(2);
  });

  it("seq 缺口标记需要重取 snapshot，不丢弃缺口后的可用事件", () => {
    const state = createUiState({ clock: () => NOW });
    state.applyEvent({ type: "heartbeat", seq: 1, payload: { source: "aggregator", freshness: makeFreshness(NOW) } });
    expect(state.isRefetchRequired()).toBe(false);

    state.applyEvent({ type: "heartbeat", seq: 3, payload: { source: "aggregator", freshness: makeFreshness(NOW) } });
    expect(state.isRefetchRequired()).toBe(true);

    // snapshot 到达后 seq 缺口复位。
    state.applySnapshot(makeSnapshot(NOW, []));
    expect(state.isRefetchRequired()).toBe(false);
  });
});
