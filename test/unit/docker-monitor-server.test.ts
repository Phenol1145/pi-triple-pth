import { describe, it, expect, vi } from "vitest";
import { createMonitorServer } from "../../deploy/docker-monitor/server.js";

const fullId = "deadbeef0000000000000000000000000000000000000000000000000000000000";
const startedAtMs = Date.parse("2026-01-01T00:00:01.000Z");
const now = Date.parse("2026-01-01T00:10:00.000Z");

function runningContainer() {
  return {
    Id: fullId,
    Names: ["/svc"],
    Image: "alpine:3.20",
    State: "running",
    Status: "Up 2 hours",
    Ports: [],
  };
}

function inspectJson() {
  return {
    Id: fullId,
    Name: "/svc",
    Created: "2026-01-01T00:00:00.000Z",
    State: {
      StartedAt: "2026-01-01T00:00:01.000Z",
      FinishedAt: "0001-01-01T00:00:00.000Z",
      Running: true,
    },
    Config: { Image: "alpine:3.20" },
  };
}

function statsFrame() {
  return {
    cpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 10_000, online_cpus: 4 },
    memory_stats: { usage: 1_000_000, limit: 4_000_000 },
    networks: { eth0: { rx_bytes: 100, tx_bytes: 200 } },
  };
}

function makeDocker(overrides: Record<string, unknown> = {}) {
  return {
    getContainers: vi.fn(async () => []),
    inspectContainer: vi.fn(async () => inspectJson()),
    getContainerStats: vi.fn(async () => statsFrame()),
    ...overrides,
  };
}

async function startAndGetPort(monitor: ReturnType<typeof createMonitorServer>) {
  await monitor.start();
  const addr = monitor.server.address();
  if (addr && typeof addr === "object") return addr.port;
  throw new Error("server did not bind");
}

function parseSseBlock(block: string) {
  const ev: { id?: string; event?: string; data?: string } = {};
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) ev.id = line.slice(3).trim();
    else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
    else if (line.startsWith("data:")) ev.data = line.slice(5).trim();
  }
  return ev;
}

async function readSseEvents(res: Response, count: number) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Array<{ id?: string; event?: string; data?: string }> = [];
  const timer = setTimeout(() => void reader.cancel(), 3000);
  try {
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSseBlock(block);
        if (ev.event) events.push(ev);
        if (events.length >= count) break;
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

describe("docker-monitor createMonitorServer", () => {
  it("import/create 不自动监听、不启动定时采集", () => {
    const docker = makeDocker();
    const monitor = createMonitorServer({ port: 0, docker, clock: () => now });

    expect(monitor.server.listening).toBe(false);
    expect(docker.getContainers).not.toHaveBeenCalled();
    expect(docker.inspectContainer).not.toHaveBeenCalled();
  });

  it("host 默认 127.0.0.1", async () => {
    const monitor = createMonitorServer({ port: 0, docker: makeDocker(), clock: () => now });
    await monitor.start();
    try {
      const addr = monitor.server.address();
      expect(addr && typeof addr === "object" ? addr.address : null).toBe("127.0.0.1");
    } finally {
      await monitor.close();
    }
  });

  it("embed 模式：GET /?embed=1&base=/observe 返回同一观测台 HTML", async () => {
    const monitor = createMonitorServer({ port: 0, docker: makeDocker(), clock: () => now });
    const port = await startAndGetPort(monitor);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/?embed=1&base=/observe`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");

      const html = await res.text();
      expect(html).toContain("N30 运行观测台");
      expect(html).toContain("validateEmbedBase");
    } finally {
      await monitor.close();
    }
  });

  it("/snapshot 返回 intervals/samples/freshness", async () => {
    const docker = makeDocker({
      getContainers: vi.fn(async () => [runningContainer()]),
      inspectContainer: vi.fn(async () => inspectJson()),
      getContainerStats: vi.fn(async () => statsFrame()),
    });
    const monitor = createMonitorServer({ port: 0, intervalMs: 2000, maxSamples: 1800, docker, clock: () => now });
    await monitor.collectOnce();
    const port = await startAndGetPort(monitor);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/snapshot`);
      expect(res.status).toBe(200);

      const snap = await res.json();
      expect(snap.snapshotId).toBeTruthy();
      expect(snap.collectedAt).toBe(now);
      expect(snap.intervals).toHaveLength(1);
      expect(snap.samples).toHaveLength(1);
      expect(snap.sources).toHaveLength(1);

      const iv = snap.intervals[0];
      expect(iv.id).toBe(`service:${fullId}:${startedAtMs}`);
      expect(iv.kind).toBe("service");
      expect(iv.label).toBe("svc");
      expect(iv.status).toBe("running");
      expect(iv.startAt).toBe(startedAtMs);
      expect(iv.endAt).toBeNull();
      expect(iv.sourceVersion).toBe(`${startedAtMs}`);

      const s = snap.samples[0];
      expect(s.ts).toBe(now);
      expect(s.targetKind).toBe("container");
      expect(s.targetId).toBe(fullId);
      expect(s.cpuPercent).toBeNull(); // 首帧无 prev，不伪造 CPU%
      expect(s.rssBytes).toBe(1_000_000);
      expect(s.netRxBytes).toBe(100);

      expect(snap.sources[0].source).toBe("docker");
      expect(snap.sources[0].state).toBe("fresh");
      expect(snap.sources[0].expectedIntervalMs).toBe(2000);
      // 正常场景：告警为空数组（不是占位 0）。
      expect(snap.summary.alerts).toEqual([]);
    } finally {
      await monitor.close();
    }
  });

  it("/events SSE 发送 resource-sample/service-interval/heartbeat 且带事件 ID", async () => {
    const docker = makeDocker({
      getContainers: vi.fn(async () => [runningContainer()]),
      inspectContainer: vi.fn(async () => inspectJson()),
      getContainerStats: vi.fn(async () => statsFrame()),
    });
    const monitor = createMonitorServer({ port: 0, intervalMs: 2000, maxSamples: 1800, docker, clock: () => now });
    await monitor.collectOnce();
    const port = await startAndGetPort(monitor);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: AbortSignal.timeout(3000) });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const events = await readSseEvents(res, 3);
      const types = events.map((e) => e.event);
      expect(types).toContain("resource-sample");
      expect(types).toContain("service-interval");
      expect(types).toContain("heartbeat");
      for (const ev of events) expect(ev.id).toBeTruthy();
    } finally {
      await monitor.close();
    }
  });

  it("/snapshot 在 PTH heartbeat stale 时产生 alert，/events 发出 alert 事件（upsert id + 全局 seq）", async () => {
    let nowMs = 0;
    let pthDown = false;
    const pthFetch = vi.fn(async (url: string, init: { method: string }) => {
      const parsed = new URL(url);
      expect(init.method).toBe("GET");
      if (parsed.pathname.endsWith("/runtime/events")) {
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      expect(parsed.pathname).toBe("/api/v1/observe/timeline");
      if (pthDown) throw new Error("pth down");
      return new Response(JSON.stringify({
        intervals: [],
        nextCursor: null,
        window: { from: nowMs - 3_600_000, to: nowMs },
        scope: { mode: "local-admin", tenantId: "tenant-a" },
        sourceObservedAt: nowMs,
        collectedAt: nowMs,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const monitor = createMonitorServer({
      port: 0,
      intervalMs: 2000,
      docker: makeDocker({ getContainers: vi.fn(async () => []) }),
      clock: () => nowMs,
      pth: {
        endpoint: "http://127.0.0.1:4000",
        token: "runtime-observer-test-token",
        fetchImpl: pthFetch,
      },
    });

    // 首次成功：pth-timeline fresh → alerts 为空数组。
    await monitor.collectOnce();
    expect(monitor.snapshot().summary.alerts).toEqual([]);

    // 先以健康 PTH 启动服务器（pthClient.start() 的即时 poll 不会失败）。
    const port = await startAndGetPort(monitor);
    try {
      // PTH 失败且时间越过 staleAfterMs → /snapshot 的 summary.alerts 非空且形状正确。
      pthDown = true;
      nowMs = 16_001;
      await monitor.collectOnce();
      const snap = monitor.snapshot();
      expect(Array.isArray(snap.summary.alerts)).toBe(true);
      expect(snap.summary.alerts.length).toBeGreaterThan(0);

      const staleAlert = snap.summary.alerts.find((a: { code?: string }) => a.code === "heartbeat.stale");
      expect(staleAlert).toBeTruthy();
      expect(staleAlert.source).toBe("pth-timeline");
      expect(staleAlert.interval).toBeNull();
      expect(Number.isFinite(staleAlert.evidenceWindow.from)).toBe(true);
      expect(staleAlert.evidenceWindow.to).toBe(nowMs);
      expect(staleAlert.id).toContain("heartbeat.stale:pth-timeline:");

      // /events 初始连接在 snapshot 后发送 alert 事件，且事件 ID 单调（全局 seq）。
      const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: AbortSignal.timeout(3000) });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const events = await readSseEvents(res, 4);
      const alertEvents = events.filter((ev) => ev.event === "alert");
      expect(alertEvents.length).toBeGreaterThan(0);
      const alertPayload = JSON.parse(alertEvents[0]!.data!);
      expect(alertPayload.code).toBe("heartbeat.stale");
      expect(alertPayload.source).toBe("pth-timeline");
      expect(alertPayload.id).toContain("heartbeat.stale:pth-timeline:");

      const ids = events.map((ev) => Number(ev.id)).filter((n) => Number.isFinite(n));
      for (let i = 1; i < ids.length; i += 1) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
      }
    } finally {
      await monitor.close();
    }
  });

  it("Docker 不可用时 /snapshot 仍 200 且 sourceState=disconnected", async () => {
    const docker = makeDocker({
      getContainers: vi.fn(async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      }),
    });
    const monitor = createMonitorServer({ port: 0, intervalMs: 2000, maxSamples: 1800, docker, clock: () => now });
    await monitor.collectOnce();
    const port = await startAndGetPort(monitor);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/snapshot`);
      expect(res.status).toBe(200);

      const snap = await res.json();
      expect(snap.sources[0].state).toBe("disconnected");
      expect(snap.intervals).toEqual([]);
      expect(snap.samples).toEqual([]);
    } finally {
      await monitor.close();
    }
  });

  it("stats 拉取失败时 null metric 保留 null，绝不合成 0", async () => {
    const docker = makeDocker({
      getContainers: vi.fn(async () => [runningContainer()]),
      inspectContainer: vi.fn(async () => inspectJson()),
      getContainerStats: vi.fn(async () => {
        throw new Error("stats unavailable");
      }),
    });
    const monitor = createMonitorServer({ port: 0, intervalMs: 2000, maxSamples: 1800, docker, clock: () => now });
    await monitor.collectOnce();
    const port = await startAndGetPort(monitor);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/snapshot`);
      expect(res.status).toBe(200);

      const snap = await res.json();
      const s = snap.samples[0];
      expect(s.cpuPercent).toBeNull();
      expect(s.rssBytes).toBeNull();
      expect(s.cpuPercent).not.toBe(0);
      expect(s.rssBytes).not.toBe(0);
    } finally {
      await monitor.close();
    }
  });
});
