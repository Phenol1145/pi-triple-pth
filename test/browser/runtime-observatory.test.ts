import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createUiState, validateEmbedBase } from "../../deploy/docker-monitor/ui-state.js";
import {
  renderGanttSvg,
  buildGanttModel,
  buildResourceModel,
  buildDetailModel,
  renderTextSummary,
} from "../../deploy/docker-monitor/charts.js";

/**
 * N30 Task 5 Step 6：浏览器验收测试（仓内无 jsdom/happy-dom，按计划用纯 DOM 断言近似，
 * 并在最终汇报中说明）。测试直接消费与 index.html 相同的 ui-state.js / charts.js 模块，
 * 模拟 initial snapshot → live upsert → 断线重连 → pause → 层级 → 联动缩放 →
 * 缺失数据 → stale 状态 → Docker/PTH 不可用 banner 的完整事件管线；
 * 并检查页面源码不包含 Docker socket 路径或任何凭据字段。
 */

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const HOUR = 3_600_000;

function makeFreshness(sourceObservedAt: number, staleAfterMs = 15000) {
  return {
    sourceObservedAt,
    collectedAt: sourceObservedAt,
    expectedIntervalMs: 5000,
    staleAfterMs,
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
    label: overrides.label ?? id,
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
    detail: overrides.detail ?? { retry: 0, error: null },
    ...overrides,
  };
}

function makeSample(ts: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    freshness: makeFreshness(ts, 6000),
    ...overrides,
  };
}

function makeSnapshot(
  snapshotId: string,
  collectedAt: number,
  intervals: Array<Record<string, unknown>>,
  samples: Array<Record<string, unknown>> = [],
  sources: Array<Record<string, unknown>> = [],
  warnings: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  return {
    snapshotId,
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
    warnings,
  };
}

function readDeployFile(name: string): string {
  const url = new URL(`../../deploy/docker-monitor/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

describe("runtime-observatory browser acceptance (纯 DOM 近似)", () => {
  it("页面源码与浏览器模块不含 Docker socket 路径或凭据字段", () => {
    const html = readDeployFile("index.html");
    const uiState = readDeployFile("ui-state.js");
    const charts = readDeployFile("charts.js");
    const browserSource = `${html}\n${uiState}\n${charts}`;

    expect(browserSource).not.toContain("DOCKER_SOCKET");
    expect(browserSource).not.toContain("/var/run/docker.sock");
    expect(browserSource).not.toContain("MONITOR_PTH_TOKEN");
    expect(browserSource).not.toContain("localStorage");
    expect(html).toContain('id="source-banners"');
    expect(html).toContain("Docker 不可用");
    expect(html).toContain("PTH 不可用");
    expect(html).toContain("ui-state.js");
    expect(html).toContain("charts.js");
  });

  it("initial snapshot 渲染甘特层级与资源序列", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot("snap-1", NOW, [
      makeInterval("service:docker:1", { kind: "service", workMode: undefined, label: "svc", startAt: NOW - 700_000 }),
      makeInterval("job:tenant-a:j1", { kind: "job", workMode: undefined, label: "job-1", startAt: NOW - 600_000 }),
      makeInterval("task:tenant-a:t1:attempt:1", {
        parentId: "job:tenant-a:j1", kind: "task", workMode: "run", startAt: NOW - 500_000,
      }),
    ], [makeSample(NOW - 1000)]));

    const gantt = buildGanttModel(state, { renderedAt: NOW });
    expect(gantt.lanes.map((lane) => lane.id)).toEqual([
      "job:tenant-a:j1",
      "task:tenant-a:t1:attempt:1",
      "service:docker:1",
    ]);
    expect(renderGanttSvg(state, { renderedAt: NOW })).toContain('data-lane-id="service:docker:1"');

    const resources = buildResourceModel(state, { renderedAt: NOW });
    expect(resources.series).toHaveLength(4);
    expect(state.getVisibleSamples()).toHaveLength(1);
  });

  it("live upsert 更新区间并反映到 SVG/详情", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot("snap-1", NOW, [
      makeInterval("task:tenant-a:t1:attempt:1", {
        kind: "task", workMode: "run", startAt: NOW - 500_000,
      }),
    ]));

    state.applyEvent({
      type: "interval.upsert",
      seq: 1,
      payload: makeInterval("task:tenant-a:t1:attempt:1", {
        kind: "task",
        workMode: "run",
        startAt: NOW - 500_000,
        status: "completed",
        endAt: NOW - 1000,
        sourceVersion: "2",
      }),
    });

    const rows = state.getIntervals();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.sourceVersion).toBe("2");

    state.selectInterval("task:tenant-a:t1:attempt:1");
    const detail = buildDetailModel(state, { renderedAt: NOW });
    expect(detail?.workerId).toBe("w1");
    expect(detail?.batchId).toBe("b1");
  });

  it("断线重连：新 snapshot 全量替换，seq 缺口触发重取标记", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot("snap-1", NOW, [
      makeInterval("task:tenant-a:t1:attempt:1", { kind: "task", workMode: "run", startAt: NOW - 500_000 }),
    ]));

    // 模拟 seq 缺口（浏览器据此在重连后先重取快照）。
    state.applyEvent({ type: "heartbeat", seq: 1, payload: { source: "aggregator", freshness: makeFreshness(NOW) } });
    state.applyEvent({ type: "heartbeat", seq: 5, payload: { source: "aggregator", freshness: makeFreshness(NOW) } });
    expect(state.isRefetchRequired()).toBe(true);

    // 重连后快照：旧区间被替换为终态。
    state.applySnapshot(makeSnapshot("snap-2", NOW, [
      makeInterval("task:tenant-a:t1:attempt:1", {
        kind: "task",
        workMode: "run",
        startAt: NOW - 500_000,
        status: "completed",
        endAt: NOW - 2000,
        sourceVersion: "3",
      }),
    ]));
    expect(state.isRefetchRequired()).toBe(false);
    expect(state.getSnapshotId()).toBe("snap-2");
    expect(state.getIntervals()[0]?.status).toBe("completed");
  });

  it("暂停冻结窗口；恢复请求重取快照", () => {
    let now = NOW;
    const state = createUiState({ clock: () => now });
    state.applySnapshot(makeSnapshot("snap-1", now, []));
    state.setPreset("15m");
    const frozen = { ...state.getWindow() };

    state.setPaused(true);
    now = NOW + 120_000;
    state.applyEvent({ type: "heartbeat", seq: 1, payload: { source: "aggregator", freshness: makeFreshness(now) } });
    expect(state.getWindow()).toEqual(frozen);

    state.resume();
    expect(state.isPaused()).toBe(false);
    expect(state.isRefetchRequired()).toBe(true);
  });

  it("联动缩放：资源图 brush 反向更新甘特窗口，两个模型共享同一窗口对象", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot("snap-1", NOW, [
      makeInterval("task:tenant-a:t1:attempt:1", { kind: "task", workMode: "run", startAt: NOW - 500_000 }),
    ], [makeSample(NOW - 1000)]));

    state.zoomFromBrush(NOW - 300_000, NOW - 60_000);
    const gantt = buildGanttModel(state, { renderedAt: NOW });
    const resources = buildResourceModel(state, { renderedAt: NOW });
    expect(gantt.window).toBe(state.getWindow());
    expect(resources.window).toBe(state.getWindow());
    expect(state.getWindow()).toEqual({ from: NOW - 300_000, to: NOW - 60_000 });
  });

  it("缺失数据：null 样本成缺口，摘要显示 unknown 而非 0", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot("snap-1", NOW, [], [
      makeSample(NOW - 2000, { cpuPercent: 10, rssBytes: 1000, heapUsedBytes: 2000 }),
      makeSample(NOW - 1000, { cpuPercent: null, rssBytes: null, heapUsedBytes: null }),
    ]));

    const model = buildResourceModel(state, { renderedAt: NOW });
    const cpu = model.series.find((s) => s.key === "cpu")!;
    expect(cpu.points.map((p) => p.value)).toEqual([10, null]);
    expect(cpu.segments).toHaveLength(1);
    expect(cpu.gaps).toEqual([{ from: NOW - 1000, to: NOW - 1000 }]);

    const text = renderTextSummary(state, { renderedAt: NOW });
    expect(text).toContain("unknown");
  });

  it("stale 状态：来源冻结并灰显，Docker/PTH 不可用产生降级 banner 数据", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot("snap-1", NOW, [
      makeInterval("task:tenant-a:t1:attempt:1", {
        kind: "task",
        workMode: "run",
        startAt: NOW - 600_000,
        freshness: makeFreshness(NOW - 30_000),
      }),
    ], [], [
      { source: "docker", state: "disconnected", lastSuccessAt: NOW - 60_000, lastAttemptAt: NOW, expectedIntervalMs: 2000, staleAfterMs: 6000, consecutiveFailures: 3 },
      { source: "pth-timeline", state: "disconnected", lastSuccessAt: NOW - 60_000, lastAttemptAt: NOW, expectedIntervalMs: 5000, staleAfterMs: 15000, consecutiveFailures: 3 },
    ]));

    const sourceStates = state.getSourceStates(NOW);
    expect(sourceStates.find((s) => s.source === "docker")?.state).toBe("disconnected");
    expect(sourceStates.find((s) => s.source === "pth-timeline")?.state).toBe("disconnected");

    const gantt = buildGanttModel(state, { renderedAt: NOW });
    const task = gantt.lanes.find((lane) => lane.id === "task:tenant-a:t1:attempt:1")!;
    expect(task.stale).toBe(true);
    expect(renderGanttSvg(state, { renderedAt: NOW })).toContain('class="bar stale"');
  });

  it("embed base 校验：仅接受同源绝对路径", () => {
    expect(validateEmbedBase("/observe")).toBe("/observe");
    expect(validateEmbedBase("/observe/")).toBe("/observe");
    expect(validateEmbedBase("/")).toBe("/");
    expect(validateEmbedBase("http://evil.example/observe")).toBeNull();
    expect(validateEmbedBase("//evil.example/observe")).toBeNull();
    expect(validateEmbedBase("/../etc")).toBeNull();
    expect(validateEmbedBase("/%2fetc")).toBeNull();
    expect(validateEmbedBase("/a?b=1")).toBeNull();
    expect(validateEmbedBase("/a#b")).toBeNull();
    expect(validateEmbedBase(null)).toBeNull();
  });
});
