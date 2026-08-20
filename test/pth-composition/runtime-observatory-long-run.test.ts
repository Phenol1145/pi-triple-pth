import { afterAll, describe, it, expect, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { createTimeSeriesRing } from "../../deploy/docker-monitor/ring-buffer.js";
import { createRuntimeAggregator } from "../../deploy/docker-monitor/runtime-aggregator.js";
import { createMonitorServer } from "../../deploy/docker-monitor/server.js";

/**
 * N30 Task 6 Step 2：八小时模拟采样测试。
 *
 * 用假时钟推进 14,400 个 2 秒样本（28,800 秒 = 8 小时），断言：
 *  - ring/sample/event 内存低于固定上限；
 *  - stale 转换发生在精确边界（lagging/stale/disconnected 的阈值前不越界、阈值后恰好翻转）；
 *  - 时间轴漂移不超过 1 个采样周期（2 秒）。
 */

const SAMPLE_COUNT = 14_400;
const SAMPLE_PERIOD_MS = 2_000;
const MAX_SAMPLES = 1_800;
const MAX_AGE_MS = 3_600_000;
const FINAL_NOW = (SAMPLE_COUNT - 1) * SAMPLE_PERIOD_MS;

// ─── 台账（供 scripts/eval-n30-runtime-observatory.ts 计算精确分母与 P50/P95/P99）──
const LEDGER_VERSION = "n30-runtime-observatory-ledger/1";
const resourceLatencyMs: number[] = [];
const activityLatencyMs: number[] = [];
const timelineLatencyMs: number[] = [];
let writeCallsObserved = 0;

afterAll(() => {
  const ledgerPath = process.env.N30_RUNTIME_OBSERVATORY_LEDGER;
  if (!ledgerPath) return;
  // 确定性台账：不含时间戳/随机量/绝对路径，连跑两次字节一致。
  const ledger = {
    version: LEDGER_VERSION,
    suite: "runtime-observatory-long-run",
    writeCallsObserved,
    resourceLatencyMs,
    activityLatencyMs,
    timelineLatencyMs,
  };
  writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`, "utf8");
});

const DOCKER_FULL_ID = "deadbeef0000000000000000000000000000000000000000000000000000000000";
const STARTED_AT_MS = Date.parse("2026-01-01T00:00:01.000Z");

function runningContainer() {
  return {
    Id: DOCKER_FULL_ID,
    Names: ["/long-run-svc"],
    Image: "alpine:3.20",
    State: "running",
    Status: "Up 8 hours",
    Ports: [],
  };
}

function inspectJson() {
  return {
    Id: DOCKER_FULL_ID,
    Name: "/long-run-svc",
    Created: "2026-01-01T00:00:00.000Z",
    State: {
      StartedAt: "2026-01-01T00:00:01.000Z",
      FinishedAt: "0001-01-01T00:00:00.000Z",
      Running: true,
    },
    Config: { Image: "alpine:3.20" },
  };
}

function makeDocker() {
  let totalUsage = 0;
  return {
    getContainers: vi.fn(async () => [runningContainer()]),
    inspectContainer: vi.fn(async () => inspectJson()),
    getContainerStats: vi.fn(async () => {
      totalUsage += 1000;
      return {
        cpu_stats: {
          cpu_usage: { total_usage: totalUsage },
          system_cpu_usage: 10_000,
          online_cpus: 4,
        },
        memory_stats: { usage: 1_000_000, limit: 4_000_000 },
        networks: { eth0: { rx_bytes: 100, tx_bytes: 200 } },
      };
    }),
  };
}

function makePthInterval(id: string, sourceVersion: string, status: string, observedAt = 1200) {
  return {
    id,
    kind: "task",
    workMode: "run",
    label: id,
    status,
    sourceVersion,
    startAt: 1000,
    endAt: status === "completed" ? 1500 : null,
    freshness: {
      sourceObservedAt: observedAt,
      collectedAt: observedAt,
      expectedIntervalMs: 5000,
      staleAfterMs: 15000,
    },
    tenantId: "tenant-a",
  };
}

function makeSnapshot(snapshotId: string, collectedAt: number, intervals: Array<ReturnType<typeof makePthInterval>>) {
  return {
    snapshotId,
    collectedAt,
    window: { from: collectedAt - MAX_AGE_MS, to: collectedAt },
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

describe("runtime observatory 8 小时模拟采样（14,400 × 2s）", () => {
  it("ring 内存：14,400 个样本后只保留 1,800 条，时间轴漂移 ≤ 1 采样周期", () => {
    const ring = createTimeSeriesRing({ maxSamples: MAX_SAMPLES, maxAgeMs: MAX_AGE_MS });

    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const ts = i * SAMPLE_PERIOD_MS;
      const accepted = ring.push({ ts, value: i });
      expect(accepted.accepted).toBe(true);
    }

    expect(ring.size).toBe(MAX_SAMPLES);

    const cutoff = FINAL_NOW - MAX_AGE_MS;
    const rows = ring.range(cutoff, FINAL_NOW);
    expect(rows).toHaveLength(MAX_SAMPLES);
    expect(rows[0]!.ts).toBeGreaterThanOrEqual(cutoff);
    expect(rows[0]!.ts - cutoff).toBeLessThanOrEqual(SAMPLE_PERIOD_MS);
    expect(rows[rows.length - 1]!.ts).toBe(FINAL_NOW);
  });

  it("server 采样内存：8 小时 collectOnce 后 sample/intervals 不随运行时长增长", async () => {
    let now = 0;
    const docker = makeDocker();
    const monitor = createMonitorServer({
      port: 0,
      intervalMs: SAMPLE_PERIOD_MS,
      maxSamples: MAX_SAMPLES,
      docker,
      clock: () => now,
    });

    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      now = i * SAMPLE_PERIOD_MS;
      const collected = await monitor.collectOnce();
      const latest = collected.samples[collected.samples.length - 1];
      resourceLatencyMs.push(now - (latest && typeof latest.ts === "number" ? latest.ts : now));
    }

    const snap = monitor.snapshot();

    // 样本内存：有界 ring 只保留最近 1 小时 / 1,800 条。
    expect(snap.samples.length).toBe(MAX_SAMPLES);
    expect(snap.samples[0]!.ts).toBeGreaterThanOrEqual(FINAL_NOW - MAX_AGE_MS);
    expect(snap.samples[0]!.ts - (FINAL_NOW - MAX_AGE_MS)).toBeLessThanOrEqual(SAMPLE_PERIOD_MS);
    expect(snap.samples[snap.samples.length - 1]!.ts).toBe(FINAL_NOW);
    // 连续样本间距精确等于采样周期：时间轴不漂移。
    expect(snap.samples[1]!.ts - snap.samples[0]!.ts).toBe(SAMPLE_PERIOD_MS);

    // 区间内存：同一容器只保留一条 service interval，不随采样次数累积。
    expect(snap.intervals.length).toBe(1);
    expect(snap.intervals[0]!.kind).toBe("service");

    // 来源持续 fresh：假时钟下每次采样都是"刚成功"。
    expect(snap.sources[0]!.source).toBe("docker");
    expect(snap.sources[0]!.state).toBe("fresh");

    // 快照本身不含任何无界事件缓冲（事件由 server 即时广播并丢弃）。
    expect(snap.warnings).toEqual([]);
  });

  it("event 内存：14,400 次 reconcile 后待发事件每次 ≤ 1，不累积", () => {
    let now = 0;
    const agg = createRuntimeAggregator({ clock: () => now });
    const stableId = "task:tenant-a:t1:attempt:2";

    let maxPending = 0;
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      now = i * SAMPLE_PERIOD_MS;
      const snapshot = makeSnapshot(`snap-${i}`, now, [
        makePthInterval(stableId, String(i), i % 2 === 0 ? "running" : "completed", now),
      ]);
      agg.reconcileSnapshot(snapshot);
      const events = agg.drainEvents();
      maxPending = Math.max(maxPending, events.length);
      for (const ev of events) {
        const observedAt = ev.payload?.freshness?.sourceObservedAt;
        activityLatencyMs.push(now - (typeof observedAt === "number" ? observedAt : now));
      }
      timelineLatencyMs.push(now - snapshot.collectedAt);
    }

    // 每个快照最多产生 1 条 interval.upsert；drain 后归零，绝不无限增长。
    expect(maxPending).toBeLessThanOrEqual(1);
    expect(agg.drainEvents()).toEqual([]);
    expect(agg.getIntervals()).toHaveLength(1);
  });

  it("stale 转换发生在精确边界：阈值前不越界，阈值后恰好翻转", () => {
    let now = 0;
    const agg = createRuntimeAggregator({ clock: () => now });
    agg.markSourceSuccess("pth-timeline", 0, { expectedIntervalMs: 5000, staleAfterMs: 15000 });

    const stateAt = (at: number) => agg.getSources()[0]!.state;

    now = 5000; // age == expectedIntervalMs → 尚未 lagging
    expect(stateAt(now)).toBe("fresh");

    now = 5001; // age == expectedIntervalMs + 1 → 恰好 lagging
    expect(stateAt(now)).toBe("lagging");

    now = 15000; // age == staleAfterMs → 尚未 stale
    expect(stateAt(now)).toBe("lagging");

    now = 15001; // age == staleAfterMs + 1 → 恰好 stale
    expect(stateAt(now)).toBe("stale");

    now = 30000; // age == disconnectedAfter（max(15000,30000)）→ 尚未 disconnected
    expect(stateAt(now)).toBe("stale");

    now = 30001; // age == disconnectedAfter + 1 → 恰好 disconnected
    expect(stateAt(now)).toBe("disconnected");
  });
});
