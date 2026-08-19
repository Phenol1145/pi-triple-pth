#!/usr/bin/env node
/**
 * docker-monitor —— 本机运行观测台 Docker 采集适配器（N30 Task 2 / O1）。
 *
 * - createMonitorServer({host,port,intervalMs,maxSamples,docker,clock}) 工厂可注入、可单测；
 *   仅当作为主模块执行（import.meta.url main guard）时才启动定时采集和监听。
 * - /snapshot 返回有界 samples、service intervals 与 docker source freshness；
 * - /events 以 SSE 推送 resource-sample / service-interval / heartbeat，并带事件 ID。
 *
 * 只读监控：Docker Socket 只在服务端打开，永不暴露给浏览器。
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultDockerClient } from "./docker-api.js";
import { computeMetrics, buildContainerInterval } from "./metrics.js";
import { createTimeSeriesRing } from "./ring-buffer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAX_AGE_MS = 3_600_000;

let htmlCache = null;
function getHtml() {
  if (htmlCache === null) htmlCache = readFileSync(join(__dirname, "index.html"), "utf8");
  return htmlCache;
}

/**
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {number} [options.intervalMs]
 * @param {number} [options.maxSamples]
 * @param {{getContainers: Function, inspectContainer: Function, getContainerStats: Function}} [options.docker]
 * @param {() => number} [options.clock]
 */
export function createMonitorServer({
  host = "127.0.0.1",
  port = 9090,
  intervalMs = 2000,
  maxSamples = 1800,
  docker = defaultDockerClient,
  clock = () => Date.now(),
} = {}) {
  const maxAgeMs = DEFAULT_MAX_AGE_MS;
  const expectedIntervalMs = intervalMs;
  const staleAfterMs = Math.max(3 * expectedIntervalMs, 6000);
  const ring = createTimeSeriesRing({ maxSamples, maxAgeMs });

  /** @type {Map<string, Record<string, unknown>>} interval.id → interval */
  const intervals = new Map();
  /** @type {Map<string, string>} container id → interval.id */
  const intervalsByContainer = new Map();
  /** @type {Map<string, number>} container id → 最近一次在列表中被观测到的时间 */
  const lastSeen = new Map();
  /** @type {Map<string, Record<string, unknown>>} 每容器上一帧 stats（CPU% 两帧差） */
  const prevStats = new Map();

  const source = {
    source: "docker",
    state: "disconnected",
    lastSuccessAt: null,
    lastAttemptAt: null,
    expectedIntervalMs,
    staleAfterMs,
    consecutiveFailures: 0,
  };

  let seq = 0;

  function buildSnapshot() {
    const collectedAt = clock();
    const from = collectedAt - maxAgeMs;
    const currentIntervals = [...intervals.values()].filter((iv) => {
      if (iv.endAt === null) return true;
      return iv.endAt >= from;
    });
    return {
      snapshotId: `docker-${collectedAt}-${currentIntervals.length}-${ring.size}`,
      collectedAt,
      window: { from, to: collectedAt },
      intervals: currentIntervals,
      samples: ring.range(from, collectedAt),
      sources: [{ ...source }],
      warnings: [],
    };
  }

  function makeFreshness(observedAt) {
    return {
      sourceObservedAt: observedAt,
      collectedAt: observedAt,
      expectedIntervalMs,
      staleAfterMs,
    };
  }

  async function collectOnce() {
    const collectedAt = clock();
    source.lastAttemptAt = collectedAt;

    /** @type {Array<Record<string, unknown>>} */
    let list;
    try {
      list = await docker.getContainers();
    } catch {
      source.state = "disconnected";
      source.consecutiveFailures += 1;
      return buildSnapshot();
    }

    source.state = "fresh";
    source.lastSuccessAt = collectedAt;
    source.consecutiveFailures = 0;

    const seenContainerIds = new Set();
    for (const c of list ?? []) {
      const cid = c?.Id;
      if (!cid) continue;
      seenContainerIds.add(cid);
      lastSeen.set(cid, collectedAt);

      let inspect = null;
      try {
        inspect = await docker.inspectContainer(cid);
      } catch {
        inspect = null;
      }

      const interval = buildContainerInterval(c, inspect, {
        now: collectedAt,
        expectedIntervalMs,
      });

      const prevId = intervalsByContainer.get(cid);
      if (prevId && prevId !== interval.id) {
        // 同一 Docker ID 但 startAt 变化 → 重启产生新 revision；
        // 旧 revision 若仍处于 running，则以本次观测时间结束，保留到窗口淘汰。
        const prev = intervals.get(prevId);
        if (prev && prev.endAt === null) {
          prev.endAt = collectedAt;
          prev.status = "completed";
        }
      }
      intervals.set(interval.id, interval);
      intervalsByContainer.set(cid, interval.id);

      if (interval.status === "running") {
        try {
          const raw = await docker.getContainerStats(cid);
          const m = computeMetrics(raw, cid, prevStats.get(cid));
          prevStats.set(cid, raw);
          ring.push({
            ts: collectedAt,
            targetKind: "container",
            targetId: cid,
            cpuPercent: m.cpuPct,
            rssBytes: m.memUsage,
            heapUsedBytes: null,
            memoryLimitBytes: m.memLimit,
            netRxBytes: m.netRx,
            netTxBytes: m.netTx,
            health: c?.Health?.Status ?? "unknown",
            source: "docker",
            freshness: makeFreshness(collectedAt),
          });
        } catch {
          // stats 拉取失败（瞬时）——保留 null，绝不合成 0。
          ring.push({
            ts: collectedAt,
            targetKind: "container",
            targetId: cid,
            cpuPercent: null,
            rssBytes: null,
            heapUsedBytes: null,
            memoryLimitBytes: null,
            netRxBytes: null,
            netTxBytes: null,
            health: null,
            source: "docker",
            freshness: makeFreshness(collectedAt),
          });
        }
      } else {
        prevStats.delete(cid);
      }
    }

    // 已消失容器：尽力 inspect 拿 FinishedAt；失败则以最后观测时间结束，
    // 区间只保留到 maxAgeMs 窗口淘汰，不无限累积。
    for (const [cid, intervalId] of [...intervalsByContainer]) {
      if (seenContainerIds.has(cid)) continue;
      const iv = intervals.get(intervalId);
      if (!iv) {
        intervalsByContainer.delete(cid);
        prevStats.delete(cid);
        lastSeen.delete(cid);
        continue;
      }
      if (iv.endAt === null) {
        let inspect = null;
        try {
          inspect = await docker.inspectContainer(cid);
        } catch {
          inspect = null;
        }
        const updated = buildContainerInterval({ Id: cid }, inspect, {
          now: collectedAt,
          expectedIntervalMs,
        });
        if (updated.endAt !== null) {
          intervals.delete(intervalId);
          intervals.set(updated.id, updated);
        } else {
          iv.endAt = lastSeen.get(cid) ?? collectedAt;
          iv.status = "unknown";
        }
      }
      intervalsByContainer.delete(cid);
      prevStats.delete(cid);
      lastSeen.delete(cid);
    }

    // 窗口淘汰：结束时间早于 cutoff 的 service 区间移出当前快照。
    for (const [id, iv] of [...intervals]) {
      if (iv.endAt !== null && collectedAt - iv.endAt > maxAgeMs) {
        intervals.delete(id);
      }
    }

    return buildSnapshot();
  }

  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/") {
      try {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(getHtml());
      } catch {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("index.html missing");
      }
      return;
    }

    if (url === "/snapshot") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(buildSnapshot()));
      return;
    }

    if (url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (event, data) => {
        seq += 1;
        res.write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // 连接即补发当前快照内的 service interval 与 resource sample，再发 heartbeat。
      const snap = buildSnapshot();
      for (const iv of snap.intervals) send("service-interval", iv);
      for (const s of snap.samples) send("resource-sample", s);
      const observedAt = clock();
      send("heartbeat", {
        source: "aggregator",
        freshness: makeFreshness(observedAt),
      });

      const timer = setInterval(() => {
        const now = clock();
        send("heartbeat", {
          source: "aggregator",
          freshness: makeFreshness(now),
        });
      }, expectedIntervalMs);
      req.on("close", () => clearInterval(timer));
      return;
    }

    if (url === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ sources: [{ ...source }] }));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  }

  function close() {
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  return { server, start, collectOnce, close, snapshot: buildSnapshot };
}

// 仅当作为主模块直接执行时启动；import 到测试或其他模块时零副作用。
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  const monitorHost = process.env.MONITOR_HOST ?? "127.0.0.1";
  const monitorPort = Number(process.env.MONITOR_PORT ?? 9090);
  const monitorIntervalMs = Number(process.env.MONITOR_INTERVAL_MS ?? 2000);

  const monitor = createMonitorServer({
    host: monitorHost,
    port: monitorPort,
    intervalMs: monitorIntervalMs,
  });
  await monitor.collectOnce();
  await monitor.start();
  setInterval(() => void monitor.collectOnce(), monitorIntervalMs);
  console.log(`docker-monitor: http://${monitorHost}:${monitorPort}  (interval ${monitorIntervalMs}ms)`);
}
