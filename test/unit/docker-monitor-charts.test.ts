import { describe, it, expect } from "vitest";
import { createUiState } from "../../deploy/docker-monitor/ui-state.js";
import {
  STATUS_COLORS,
  renderGanttSvg,
  buildGanttModel,
  buildResourceModel,
  drawResourceChart,
  buildDetailModel,
  renderTextSummary,
} from "../../deploy/docker-monitor/charts.js";

/**
 * N30 Task 5 Step 3 前测试：SVG 甘特（Job→Task→Intake/Professional Stage 层级 + 服务 lane）、
 * Canvas 资源折线（CPU/RSS/Heap/Network 同一 x 轴、null 样本段画缺口不连线、stale 段着色遮罩）。
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

function makeSample(
  ts: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ts,
    targetKind: "container",
    targetId: overrides.targetId ?? "c1",
    cpuPercent: overrides.cpuPercent !== undefined ? overrides.cpuPercent : 10,
    rssBytes: overrides.rssBytes !== undefined ? overrides.rssBytes : 1000,
    heapUsedBytes: overrides.heapUsedBytes !== undefined ? overrides.heapUsedBytes : 2000,
    memoryLimitBytes: 4000,
    netRxBytes: overrides.netRxBytes !== undefined ? overrides.netRxBytes : 100,
    netTxBytes: overrides.netTxBytes !== undefined ? overrides.netTxBytes : 200,
    health: "healthy",
    source: "docker",
    freshness: overrides.freshness ?? makeFreshness(ts, 6000),
    ...overrides,
  };
}

function makeSnapshot(
  collectedAt: number,
  intervals: Array<Record<string, unknown>>,
  samples: Array<Record<string, unknown>> = [],
  sources: Array<Record<string, unknown>> = [],
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
  };
}

function ganttState(overrides: Record<string, unknown> = {}) {
  const state = createUiState({ clock: () => NOW });
  state.applySnapshot(makeSnapshot(NOW, [
    makeInterval("service:docker:1", {
      kind: "service",
      workMode: undefined,
      label: "svc",
      startAt: NOW - 700_000,
      status: "running",
    }),
    makeInterval("job:tenant-a:j1", {
      kind: "job",
      workMode: undefined,
      label: "job-1",
      startAt: NOW - 600_000,
    }),
    makeInterval("task:tenant-a:t1:attempt:1", {
      parentId: "job:tenant-a:j1",
      kind: "task",
      workMode: "run",
      label: "task-1",
      startAt: NOW - 500_000,
    }),
    makeInterval("intake-run:tenant-a:i1", {
      parentId: "task:tenant-a:t1:attempt:1",
      kind: "intake-run",
      workMode: "intake",
      label: "intake-1",
      startAt: NOW - 400_000,
    }),
    makeInterval("optimizer-work:tenant-a:o1", {
      parentId: "task:tenant-a:t1:attempt:1",
      kind: "optimizer-work",
      workMode: "optimize",
      label: "optimize-1",
      startAt: NOW - 300_000,
    }),
  ]));
  return state;
}

describe("docker-monitor charts", () => {
  it("buildGanttModel 产出 Job→Task→Intake/Optimize 层级与 service lane，并共享 ui-state 窗口", () => {
    const state = ganttState();
    state.setPreset("15m");
    const model = buildGanttModel(state, { renderedAt: NOW });

    expect(model.window).toBe(state.getWindow());
    expect(model.window).toEqual({ from: NOW - 900_000, to: NOW });

    const byId = new Map(model.lanes.map((lane) => [lane.id, lane]));
    expect(byId.get("service:docker:1")?.depth).toBe(0);
    expect(byId.get("job:tenant-a:j1")?.depth).toBe(0);
    expect(byId.get("task:tenant-a:t1:attempt:1")?.depth).toBe(1);
    expect(byId.get("intake-run:tenant-a:i1")?.depth).toBe(2);
    expect(byId.get("optimizer-work:tenant-a:o1")?.depth).toBe(2);
    expect(model.timeDomain).toEqual([NOW - 900_000, NOW]);
  });

  it("renderGanttSvg 使用固定状态色，Work Mode 独立标记，stale 区间灰显", () => {
    const state = ganttState();
    state.applyEvent({
      type: "interval.upsert",
      payload: makeInterval("task:tenant-a:t1:attempt:1", {
        parentId: "job:tenant-a:j1",
        kind: "task",
        workMode: "run",
        label: "task-1",
        startAt: NOW - 500_000,
        status: "failed",
        sourceVersion: "2",
        freshness: makeFreshness(NOW - 1000),
      }),
    });
    state.applyEvent({
      type: "interval.upsert",
      payload: makeInterval("intake-run:tenant-a:i1", {
        parentId: "task:tenant-a:t1:attempt:1",
        kind: "intake-run",
        workMode: "intake",
        label: "intake-1",
        startAt: NOW - 400_000,
        status: "waiting",
        sourceVersion: "2",
        freshness: makeFreshness(NOW - 20_000),
      }),
    });

    const svg = renderGanttSvg(state, { renderedAt: NOW, width: 960 });
    expect(svg).toContain("<svg");
    expect(svg).toContain('data-lane-id="job:tenant-a:j1"');
    expect(svg).toContain('data-lane-id="service:docker:1"');
    expect(svg).toContain(`fill="${STATUS_COLORS.running}"`);
    expect(svg).toContain(`fill="${STATUS_COLORS.failed}"`);
    // Work Mode 独立图形标记，不覆盖状态色。
    expect(svg).toContain('data-work-mode="run"');
    expect(svg).toContain('data-work-mode="intake"');
    // 超龄 interval 灰显。
    expect(svg).toContain('class="bar stale"');
    expect(svg).toContain(`fill="${STATUS_COLORS.stale}"`);
  });

  it("运行中区间只延伸到 renderedAt；stale 运行区间冻结在 sourceObservedAt", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot(NOW, [
      makeInterval("task:tenant-a:t1:attempt:1", {
        kind: "task",
        workMode: "run",
        startAt: NOW - 600_000,
        endAt: null,
        freshness: makeFreshness(NOW - 1000, 15000),
      }),
      makeInterval("task:tenant-a:t2:attempt:1", {
        kind: "task",
        workMode: "run",
        startAt: NOW - 600_000,
        endAt: null,
        freshness: makeFreshness(NOW - 20_000, 15000),
      }),
    ]));

    const model = buildGanttModel(state, { renderedAt: NOW });
    const t1 = model.lanes.find((lane) => lane.id === "task:tenant-a:t1:attempt:1")!;
    const t2 = model.lanes.find((lane) => lane.id === "task:tenant-a:t2:attempt:1")!;

    expect(t1.effectiveEnd).toBe(NOW);
    expect(t2.effectiveEnd).toBe(NOW - 20_000);
    expect(t2.stale).toBe(true);
  });

  it("buildResourceModel 四条序列共享同一 x 轴；null 样本成缺口不连线", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot(NOW, [], [
      makeSample(NOW - 3000, { cpuPercent: 10, rssBytes: 1000, heapUsedBytes: 2000, netRxBytes: 100, netTxBytes: 200 }),
      makeSample(NOW - 2000, { cpuPercent: null, rssBytes: null, heapUsedBytes: null, netRxBytes: null, netTxBytes: null }),
      makeSample(NOW - 1000, { cpuPercent: 20, rssBytes: 1500, heapUsedBytes: 2500, netRxBytes: 300, netTxBytes: 500 }),
      makeSample(NOW - 500, { cpuPercent: 30, rssBytes: 1600, heapUsedBytes: 2600, netRxBytes: 500, netTxBytes: 700 }),
    ]));

    const model = buildResourceModel(state, { renderedAt: NOW });
    expect(model.window).toBe(state.getWindow());
    expect(model.timeDomain).toEqual([state.getWindow().from, state.getWindow().to]);

    const keys = model.series.map((s) => s.key).sort();
    expect(keys).toEqual(["cpu", "heap", "net", "rss"]);

    const cpu = model.series.find((s) => s.key === "cpu")!;
    expect(cpu.points.map((p) => p.value)).toEqual([10, null, 20, 30]);
    // 一个 null 样本形成一段缺口；连续非 null 点构成可绘制段。
    expect(cpu.gaps).toEqual([{ from: NOW - 2000, to: NOW - 2000 }]);
    expect(cpu.segments).toHaveLength(2);
    expect(cpu.segments[0].map((p) => p.ts)).toEqual([NOW - 3000]);
    expect(cpu.segments[1].map((p) => p.ts)).toEqual([NOW - 1000, NOW - 500]);

    // Network 序列 = 相邻样本的 bytes/second（rx+tx 增量 / 秒）；
    // 中间 null 样本不合成数据，其后续样本因无直接前值而为 null。
    const net = model.series.find((s) => s.key === "net")!;
    expect(net.points[0]?.value).toBeNull(); // 首样本无前值，无法计算速率
    expect(net.points[2]?.value).toBeNull(); // 前一样本 rx/tx 缺失
    expect(net.points[3]?.value).toBeCloseTo(((500 + 700) - (300 + 500)) / 500 * 1000, 6);

    // 所有序列使用同一 xScale。
    const x0 = model.xScale(NOW - 3000);
    expect(x0).toBe(model.xScale(NOW - 3000));
    for (const s of model.series) {
      expect(s.xScale).toBe(model.xScale);
    }
  });

  it("drawResourceChart 用 moveTo 断开 null 缺口，stale 段画着色遮罩", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot(NOW, [], [
      makeSample(NOW - 4000, { cpuPercent: 8, freshness: makeFreshness(NOW - 4000, 6000) }),
      makeSample(NOW - 3000, { cpuPercent: 10, freshness: makeFreshness(NOW - 3000, 6000) }),
      makeSample(NOW - 2000, { cpuPercent: null, freshness: makeFreshness(NOW - 2000, 6000) }),
      makeSample(NOW - 1000, {
        cpuPercent: 20,
        // 该样本超龄 → stale 遮罩。
        freshness: makeFreshness(NOW - 30_000, 6000),
      }),
      makeSample(NOW - 500, {
        cpuPercent: 30,
        freshness: makeFreshness(NOW - 30_000, 6000),
      }),
    ]));

    const model = buildResourceModel(state, { renderedAt: NOW });
    expect(model.staleRanges.length).toBeGreaterThan(0);

    const ops: Array<string> = [];
    const ctx: Record<string, unknown> = {};
    for (const method of ["beginPath", "moveTo", "lineTo", "stroke", "fillRect", "save", "restore"]) {
      ctx[method] = (...args: unknown[]) => {
        ops.push(`${method}(${args.map((a) => Number(a).toFixed(0)).join(",")})`);
      };
    }
    let fillStyle = "";
    let strokeStyle = "";
    Object.defineProperty(ctx, "fillStyle", {
      set(v: unknown) {
        fillStyle = String(v);
        ops.push(`fillStyle=${fillStyle}`);
      },
      get() {
        return fillStyle;
      },
    });
    Object.defineProperty(ctx, "strokeStyle", {
      set(v: unknown) {
        strokeStyle = String(v);
        ops.push(`strokeStyle=${strokeStyle}`);
      },
      get() {
        return strokeStyle;
      },
    });

    drawResourceChart(ctx as CanvasRenderingContext2D, model, { width: 800, height: 200 });

    // 缺口之后必须重新 moveTo，而不是从 null 点直接连线：
    // 两个可绘制段 → 至少两次 moveTo；第二段 moveTo 必须发生在第一段 lineTo 之后。
    const moveIndices = ops
      .map((op, i) => (op.startsWith("moveTo") ? i : -1))
      .filter((i) => i >= 0);
    const lineIndices = ops
      .map((op, i) => (op.startsWith("lineTo") ? i : -1))
      .filter((i) => i >= 0);
    expect(moveIndices.length).toBeGreaterThanOrEqual(2);
    expect(moveIndices[1]).toBeGreaterThan(lineIndices[0]);
    // 有 stale 着色遮罩（半透明灰）。
    expect(ops.some((op) => op.includes("fillRect") && fillStyle === "rgba(110,118,129,0.25)")).toBe(true);
  });

  it("buildDetailModel 输出 Worker/Role/Batch/Trace/重试/错误/usage；无选中返回 null", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot(NOW, [
      makeInterval("task:tenant-a:t1:attempt:2", {
        kind: "task",
        workMode: "run",
        startAt: NOW - 3000,
        endAt: NOW - 1000,
        status: "failed",
        attempt: 2,
        detail: { retry: 1, error: "E_TIMEOUT" },
      }),
    ], [
      makeSample(NOW - 2000, { targetId: "b1", cpuPercent: 42, rssBytes: 999, heapUsedBytes: 888 }),
    ]));

    expect(buildDetailModel(state, { renderedAt: NOW })).toBeNull();

    state.selectInterval("task:tenant-a:t1:attempt:2");
    const detail = buildDetailModel(state, { renderedAt: NOW });
    expect(detail).not.toBeNull();
    expect(detail?.workerId).toBe("w1");
    expect(detail?.roleId).toBe("lean4-prover");
    expect(detail?.batchId).toBe("b1");
    expect(detail?.traceId).toBe("tr1");
    expect(detail?.attempt).toBe(2);
    expect(detail?.retry).toBe(1);
    expect(detail?.error).toBe("E_TIMEOUT");
    expect(detail?.usage.cpuPercent.current).toBe(42);
    expect(detail?.usage.rssBytes.peak).toBe(999);
  });

  it("renderTextSummary 为无指针访问提供窗口与资源文本摘要", () => {
    const state = createUiState({ clock: () => NOW });
    state.applySnapshot(makeSnapshot(NOW, [], [
      makeSample(NOW - 1000, { cpuPercent: 12.5, rssBytes: 1024 }),
    ]));
    const text = renderTextSummary(state, { renderedAt: NOW });
    expect(text).toContain("1h");
    expect(text).toContain("12.5");
    expect(text).toContain("1.0K");
  });
});
