import { describe, it, expect, vi } from "vitest";
import {
  createAlertEvaluator,
  DEFAULT_ALERT_THRESHOLDS,
  evaluateAlerts,
} from "../../deploy/docker-monitor/alerts.js";

/**
 * N30 Task 6 Step 1：告警正/负探针。
 *
 * 五类告警：heartbeat stale/dead、队列积压、CPU/RSS 阈值、任务超时、
 * 摄入/专业阶段停滞。每条告警必须含 source、interval 与 evidenceWindow；
 * 评估器只读——绝不调用控制 API。
 */

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;

function makeSource(overrides: Record<string, unknown> = {}) {
  return {
    source: "pth-timeline",
    state: "fresh",
    lastSuccessAt: NOW - 1000,
    lastAttemptAt: NOW - 1000,
    sourceObservedAt: NOW - 1000,
    expectedIntervalMs: 5000,
    staleAfterMs: 15000,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function makeInterval(id: string, overrides: Record<string, unknown> = {}) {
  const kind = id.split(":")[0] ?? "task";
  return {
    id,
    kind,
    workMode: overrides.workMode ?? (kind === "task" ? "run" : kind === "intake-run" ? "intake" : "optimize"),
    label: id,
    status: overrides.status ?? "running",
    sourceVersion: "1",
    startAt: overrides.startAt ?? NOW - 60_000,
    endAt: overrides.endAt ?? null,
    freshness: {
      sourceObservedAt: NOW - 1000,
      collectedAt: NOW - 1000,
      expectedIntervalMs: 5000,
      staleAfterMs: 15000,
    },
    tenantId: "tenant-a",
    ...overrides,
  };
}

function expectAlertShape(alert: Record<string, unknown> | undefined) {
  expect(alert).toBeTruthy();
  if (!alert) return;
  expect(typeof alert["source"]).toBe("string");
  expect((alert["source"] as string).length).toBeGreaterThan(0);
  expect(Object.prototype.hasOwnProperty.call(alert, "interval")).toBe(true);
  expect(alert["evidenceWindow"]).toBeTruthy();
  const window = alert["evidenceWindow"] as { from: number; to: number };
  expect(Number.isFinite(window.from)).toBe(true);
  expect(Number.isFinite(window.to)).toBe(true);
  expect(window.to).toBeGreaterThanOrEqual(window.from);
}

describe("docker-monitor alerts：heartbeat stale/dead", () => {
  it("正探针：来源 stale → heartbeat.stale，含 source/interval/evidence window", () => {
    const alerts = evaluateAlerts(
      {
        now: NOW,
        sources: [makeSource({ source: "pth-timeline", state: "stale", sourceObservedAt: NOW - 16_000 })],
        intervals: [],
        samples: [],
        summary: {},
      },
      { thresholds: { ...DEFAULT_ALERT_THRESHOLDS } },
    );

    const alert = alerts.find((a) => a.code === "heartbeat.stale");
    expectAlertShape(alert);
    expect(alert?.source).toBe("pth-timeline");
    expect(alert?.interval).toBeNull();
  });

  it("正探针：来源 disconnected → heartbeat.dead", () => {
    const alerts = evaluateAlerts(
      {
        now: NOW,
        sources: [makeSource({ source: "docker", state: "disconnected", sourceObservedAt: NOW - 60_000 })],
        intervals: [],
        samples: [],
        summary: {},
      },
      { thresholds: { ...DEFAULT_ALERT_THRESHOLDS } },
    );

    const alert = alerts.find((a) => a.code === "heartbeat.dead");
    expectAlertShape(alert);
    expect(alert?.source).toBe("docker");
    expect(alert?.interval).toBeNull();
  });

  it("负探针：fresh 来源不产生任何 heartbeat 告警", () => {
    const alerts = evaluateAlerts(
      {
        now: NOW,
        sources: [makeSource({ source: "pth-timeline", state: "fresh" })],
        intervals: [],
        samples: [],
        summary: {},
      },
      { thresholds: { ...DEFAULT_ALERT_THRESHOLDS } },
    );

    expect(alerts.filter((a) => a.code === "heartbeat.stale" || a.code === "heartbeat.dead")).toEqual([]);
  });
});

describe("docker-monitor alerts：队列积压", () => {
  it("正探针：queuedTasks 达到阈值 → queue.backlog", () => {
    const alerts = evaluateAlerts(
      {
        now: NOW,
        sources: [],
        intervals: [],
        samples: [],
        summary: { queuedTasks: 21 },
      },
      { thresholds: { ...DEFAULT_ALERT_THRESHOLDS, queueBacklog: 20 } },
    );

    const alert = alerts.find((a) => a.code === "queue.backlog");
    expectAlertShape(alert);
    expect(alert?.source).toBe("aggregator");
    expect(alert?.interval).toBeNull();
    expect(alert?.value).toBe(21);
  });

  it("负探针：queuedTasks 低于阈值不告警", () => {
    const alerts = evaluateAlerts(
      {
        now: NOW,
        sources: [],
        intervals: [],
        samples: [],
        summary: { queuedTasks: 19 },
      },
      { thresholds: { ...DEFAULT_ALERT_THRESHOLDS, queueBacklog: 20 } },
    );

    expect(alerts.filter((a) => a.code === "queue.backlog")).toEqual([]);
  });
});

describe("docker-monitor alerts：CPU/RSS 阈值", () => {
  it("正探针：CPU% 超阈值 → resource.cpu", () => {
    const alerts = evaluateAlerts(
      {
        now: NOW,
        sources: [],
        intervals: [],
        samples: [{
          ts: NOW - 2000,
          source: "docker",
          targetKind: "container",
          targetId: "c1",
          cpuPercent: 95,
          rssBytes: 1000,
          heapUsedBytes: null,
          netRxBytes: 0,
          netTxBytes: 0,
        }],
        summary: {},
      },
      { thresholds: { ...DEFAULT_ALERT_THRESHOLDS, cpuPercent: 80 } },
    );

    const alert = alerts.find((a) => a.code === "resource.cpu");
    expectAlertShape(alert);
    expect(alert?.source).toBe("docker");
    expect(alert?.interval).toBeNull();
    expect(alert?.value).toBe(95);
  });

  it("正探针：RSS 超阈值 → resource.rss", () => {
    const alerts = evaluateAlerts(
      {
        now: NOW,
        sources: [],
        intervals: [],
        samples: [{
          ts: NOW - 2000,
          source: "docker",
          targetKind: "container",
          targetId: "c1",
          cpuPercent: 10,
          rssBytes: 2 * 1024 * 1024 * 1024,
          heapUsedBytes: null,
          netRxBytes: 0,
          netTxBytes: 0,
        }],
        summary: {},
      },
      { thresholds: { ...DEFAULT_ALERT_THRESHOLDS, rssBytes: 1 * 1024 * 1024 * 1024 } },
    );

    const alert = alerts.find((a) => a.code === "resource.rss");
    expectAlertShape(alert);
    expect(alert?.source).toBe("docker");
    expect(alert?.value).toBe(2 * 1024 * 1024 * 1024);
  });

  it("负探针：低于阈值或 null 指标不产生资源告警（缺失绝不合成 0）", () => {
    const alerts = evaluateAlerts(
      {
        now: NOW,
        sources: [],
        intervals: [],
        samples: [{
          ts: NOW - 2000,
          source: "docker",
          targetKind: "container",
          targetId: "c1",
          cpuPercent: 10,
          rssBytes: 1000,
          heapUsedBytes: null,
          netRxBytes: 0,
          netTxBytes: 0,
        }, {
          ts: NOW - 1000,
          source: "docker",
          targetKind: "container",
          targetId: "c1",
          cpuPercent: null,
          rssBytes: null,
          heapUsedBytes: null,
          netRxBytes: 0,
          netTxBytes: 0,
        }],
        summary: {},
      },
      { thresholds: { ...DEFAULT_ALERT_THRESHOLDS, cpuPercent: 80, rssBytes: 1 * 1024 * 1024 * 1024 } },
    );

    expect(alerts.filter((a) => a.code === "resource.cpu" || a.code === "resource.rss")).toEqual([]);
  });
});

describe("docker-monitor alerts：任务超时", () => {
  it("正探针：running 任务超过 taskTimeoutMs → task.timeout，interval=该任务", () => {
    const iv = makeInterval("task:tenant-a:t1:attempt:1", {
      kind: "task",
      workMode: "run",
      status: "running",
      startAt: NOW - 25 * HOUR,
      endAt: null,
    });
    const alerts = evaluateAlerts(
      {
        now: NOW,
        sources: [],
        intervals: [iv],
        samples: [],
        summary: {},
      },
      { thresholds: { ...DEFAULT_ALERT_THRESHOLDS, taskTimeoutMs: 24 * HOUR } },
    );

    const alert = alerts.find((a) => a.code === "task.timeout");
    expectAlertShape(alert);
    expect(alert?.source).toBe("pth-timeline");
    expect((alert?.interval as { id?: string } | null)?.id).toBe(iv.id);
    expect((alert?.evidenceWindow as { from: number }).from).toBe(iv.startAt);
    expect((alert?.evidenceWindow as { to: number }).to).toBe(NOW);
  });

  it("负探针：短运行任务或已完成任务不产生 task.timeout", () => {
    const young = makeInterval("task:tenant-a:t1:attempt:1", {
      kind: "task",
      status: "running",
      startAt: NOW - HOUR,
      endAt: null,
    });
    const completed = makeInterval("task:tenant-a:t2:attempt:1", {
      kind: "task",
      status: "completed",
      startAt: NOW - 48 * HOUR,
      endAt: NOW - 47 * HOUR,
    });
    const alerts = evaluateAlerts(
      {
        now: NOW,
        sources: [],
        intervals: [young, completed],
        samples: [],
        summary: {},
      },
      { thresholds: { ...DEFAULT_ALERT_THRESHOLDS, taskTimeoutMs: 24 * HOUR } },
    );

    expect(alerts.filter((a) => a.code === "task.timeout")).toEqual([]);
  });
});

describe("docker-monitor alerts：摄入/专业阶段停滞", () => {
  it("正探针：running intake-run 超过 stageStallMs → stage.stall", () => {
    const iv = makeInterval("intake-run:tenant-a:run-9", {
      kind: "intake-run",
      workMode: "intake",
      status: "running",
      startAt: NOW - 5 * HOUR,
      endAt: null,
    });
    const alerts = evaluateAlerts(
      {
        now: NOW,
        sources: [],
        intervals: [iv],
        samples: [],
        summary: {},
      },
      { thresholds: { ...DEFAULT_ALERT_THRESHOLDS, stageStallMs: 4 * HOUR } },
    );

    const alert = alerts.find((a) => a.code === "stage.stall");
    expectAlertShape(alert);
    expect(alert?.source).toBe("pth-timeline");
    expect((alert?.interval as { id?: string } | null)?.id).toBe(iv.id);
  });

  it("正探针：running professional-job 超过 stageStallMs → stage.stall", () => {
    const iv = makeInterval("professional-job:tenant-a:pj-1", {
      kind: "professional-job",
      workMode: "run",
      status: "running",
      startAt: NOW - 5 * HOUR,
      endAt: null,
    });
    const alerts = evaluateAlerts(
      {
        now: NOW,
        sources: [],
        intervals: [iv],
        samples: [],
        summary: {},
      },
      { thresholds: { ...DEFAULT_ALERT_THRESHOLDS, stageStallMs: 4 * HOUR } },
    );

    const alert = alerts.find((a) => a.code === "stage.stall");
    expectAlertShape(alert);
    expect((alert?.interval as { id?: string } | null)?.id).toBe(iv.id);
  });

  it("负探针：短运行 stage 或已完成 stage 不产生 stage.stall", () => {
    const young = makeInterval("intake-run:tenant-a:run-8", {
      kind: "intake-run",
      workMode: "intake",
      status: "running",
      startAt: NOW - HOUR,
      endAt: null,
    });
    const completed = makeInterval("professional-job:tenant-a:pj-0", {
      kind: "professional-job",
      workMode: "run",
      status: "completed",
      startAt: NOW - 8 * HOUR,
      endAt: NOW - 7 * HOUR,
    });
    const alerts = evaluateAlerts(
      {
        now: NOW,
        sources: [],
        intervals: [young, completed],
        samples: [],
        summary: {},
      },
      { thresholds: { ...DEFAULT_ALERT_THRESHOLDS, stageStallMs: 4 * HOUR } },
    );

    expect(alerts.filter((a) => a.code === "stage.stall")).toEqual([]);
  });
});

describe("docker-monitor alerts：只读安全边界", () => {
  it("评估器绝不调用控制 API（触发全部五类告警后控制面零调用）", () => {
    const controlApi = {
      startTask: vi.fn(),
      stopTask: vi.fn(),
      retryTask: vi.fn(),
      post: vi.fn(),
    };
    const evaluator = createAlertEvaluator({
      thresholds: { ...DEFAULT_ALERT_THRESHOLDS },
      controlApi,
    });

    const alerts = evaluator.evaluate({
      now: NOW,
      sources: [
        makeSource({ source: "pth-timeline", state: "stale", sourceObservedAt: NOW - 16_000 }),
        makeSource({ source: "docker", state: "disconnected", sourceObservedAt: NOW - 60_000 }),
      ],
      summary: { queuedTasks: 99 },
      intervals: [
        makeInterval("task:tenant-a:t1:attempt:1", {
          kind: "task",
          status: "running",
          startAt: NOW - 25 * HOUR,
          endAt: null,
        }),
        makeInterval("intake-run:tenant-a:run-9", {
          kind: "intake-run",
          workMode: "intake",
          status: "running",
          startAt: NOW - 5 * HOUR,
          endAt: null,
        }),
      ],
      samples: [{
        ts: NOW - 2000,
        source: "docker",
        targetKind: "container",
        targetId: "c1",
        cpuPercent: 99,
        rssBytes: 2 * 1024 * 1024 * 1024,
        heapUsedBytes: null,
        netRxBytes: 0,
        netTxBytes: 0,
      }],
    });

    expect(alerts.length).toBeGreaterThanOrEqual(6);
    for (const code of [
      "heartbeat.stale",
      "heartbeat.dead",
      "queue.backlog",
      "resource.cpu",
      "resource.rss",
      "task.timeout",
      "stage.stall",
    ]) {
      expect(alerts.some((a) => a.code === code)).toBe(true);
    }
    expect(controlApi.startTask).not.toHaveBeenCalled();
    expect(controlApi.stopTask).not.toHaveBeenCalled();
    expect(controlApi.retryTask).not.toHaveBeenCalled();
    expect(controlApi.post).not.toHaveBeenCalled();
  });
});
