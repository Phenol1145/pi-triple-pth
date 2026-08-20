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
import { createPthClient } from "./pth-client.js";
import { createRuntimeAggregator } from "./runtime-aggregator.js";

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
 * @param {object|{start: Function, stop: Function, pollOnce: Function, connectEvents?: Function}|null} [options.pth]
 *   PTH 只读客户端（prebuilt）或 createPthClient 选项（endpoint/token/...）；不传则纯 Docker 模式。
 */
export function createMonitorServer({
  host = "127.0.0.1",
  port = 9090,
  intervalMs = 2000,
  maxSamples = 1800,
  docker = defaultDockerClient,
  clock = () => Date.now(),
  pth = null,
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

  const aggregator = createRuntimeAggregator({ clock, maxAgeMs });
  const sseClients = new Set();
  let seq = 0;
  let pthClient = null;
  let pthClientStarted = false;
  let pthScope = null;

  function sseSend(res, event, data) {
    seq += 1;
    res.write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function broadcast(event, data) {
    for (const res of sseClients) {
      sseSend(res, event, data);
    }
  }

  function buildSourceStates() {
    const sources = [{ ...source }];
    if (pthClient) {
      for (const pthSource of aggregator.getSources()) {
        sources.push(pthSource);
      }
    }
    return sources;
  }

  function broadcastFreshness() {
    broadcast("freshness", { sources: buildSourceStates(), observedAt: clock() });
  }

  function handleAggregatorEvents() {
    for (const ev of aggregator.drainEvents()) {
      broadcast(ev.type, ev.payload);
    }
    broadcastFreshness();
  }

  // PTH 只读客户端装配：prebuilt 客户端直接使用；选项对象则由本工厂创建并接线。
  // 接线只调用 GET timeline/events；任何写路由都不会被本模块调用。
  if (pth) {
    if (typeof pth.start === "function") {
      pthClient = pth;
    } else {
      pthClient = createPthClient({
        ...pth,
        clock,
        onSnapshot: (snapshot) => {
          if (snapshot?.scope) pthScope = snapshot.scope;
          aggregator.reconcileSnapshot(snapshot);
          handleAggregatorEvents();
        },
        onDelta: (delta) => {
          aggregator.applyDelta(delta);
          handleAggregatorEvents();
        },
        onError: (pthSource) => {
          aggregator.markSourceFailure(pthSource);
          handleAggregatorEvents();
        },
      });
    }
  }

  function computeSummary(rows) {
    const summary = {
      activeTasks: 0,
      queuedTasks: 0,
      workers: 0,
      idleWorkers: 0,
      activeIntakeRuns: 0,
      activeOptimizeWorks: 0,
      activeRunWorks: 0,
      alerts: 0,
    };
    for (const iv of rows) {
      if (iv.kind === "task") {
        if (iv.status === "running" || iv.status === "waiting" || iv.status === "retrying") summary.activeTasks += 1;
        else if (iv.status === "queued") summary.queuedTasks += 1;
      } else if (iv.kind === "intake-run" && (iv.status === "running" || iv.status === "waiting" || iv.status === "retrying")) {
        summary.activeIntakeRuns += 1;
      } else if (iv.kind === "optimizer-work" && (iv.status === "running" || iv.status === "waiting")) {
        summary.activeOptimizeWorks += 1;
      } else if (iv.kind === "professional-job" && (iv.status === "running" || iv.status === "waiting")) {
        summary.activeRunWorks += 1;
      }
    }
    return summary;
  }

  function buildSnapshot() {
    const collectedAt = clock();
    const from = collectedAt - maxAgeMs;
    const dockerIntervals = [...intervals.values()].filter((iv) => {
      if (iv.endAt === null) return true;
      return iv.endAt >= from;
    });
    const pthIntervals = pthClient ? aggregator.getIntervals() : [];
    const allIntervals = [...dockerIntervals, ...pthIntervals];
    const snapshot = {
      snapshotId: `local-${collectedAt}-${allIntervals.length}-${ring.size}`,
      collectedAt,
      window: { from, to: collectedAt },
      scope: pthScope ?? { mode: "local-admin", tenantId: "local" },
      summary: computeSummary(allIntervals),
      intervals: allIntervals,
      samples: ring.range(from, collectedAt),
      sources: buildSourceStates(),
      warnings: [],
    };
    return snapshot;
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
    let dockerOk = true;
    try {
      list = await docker.getContainers();
    } catch {
      source.state = "disconnected";
      source.consecutiveFailures += 1;
      dockerOk = false;
      list = [];
    }

    if (dockerOk) {
      source.state = "fresh";
      source.lastSuccessAt = collectedAt;
      source.consecutiveFailures = 0;
    }

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
      broadcast("service-interval", interval);
      broadcast("interval.upsert", interval);

      if (interval.status === "running") {
        try {
          const raw = await docker.getContainerStats(cid);
          const m = computeMetrics(raw, cid, prevStats.get(cid));
          prevStats.set(cid, raw);
          const sample = {
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
          };
          ring.push(sample);
          broadcast("resource-sample", sample);
        } catch {
          // stats 拉取失败（瞬时）——保留 null，绝不合成 0。
          const sample = {
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
          };
          ring.push(sample);
          broadcast("resource-sample", sample);
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

    // PTH 轮询由 pth-client 自己的 5s timer 驱动；若尚未启动（例如测试直接调
    // collectOnce），这里同步补一次 durable snapshot，保证 /snapshot 能看到 PTH。
    if (pthClient && !pthClientStarted && typeof pthClient.pollOnce === "function") {
      try {
        await pthClient.pollOnce();
      } catch {
        // onError 已把来源标记为 failure；Docker 采样结果不受影响。
      }
    }

    return buildSnapshot();
  }

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    // embed 模式通过 query 传参（GET /?embed=1&base=/observe）；路由只看 pathname。
    const pathname = url.split("?")[0];

    if (pathname === "/") {
      try {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(getHtml());
      } catch {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("index.html missing");
      }
      return;
    }

    if (pathname === "/snapshot") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(buildSnapshot()));
      return;
    }

    if (pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sseClients.add(res);

      // 先发 heartbeat / legacy resource-sample / service-interval 保证 O1 兼容；
      // 再发统一 snapshot / freshness。之后所有实时事件都广播同一个全局 seq。
      const observedAt = clock();
      sseSend(res, "heartbeat", {
        source: "aggregator",
        freshness: makeFreshness(observedAt),
      });
      const snap = buildSnapshot();
      const dockerIntervals = [...intervals.values()].filter((iv) => {
        if (iv.endAt === null) return true;
        return iv.endAt >= snap.window.from;
      });
      for (const iv of dockerIntervals) sseSend(res, "service-interval", iv);
      for (const s of snap.samples) sseSend(res, "resource-sample", s);
      sseSend(res, "snapshot", snap);
      sseSend(res, "freshness", { sources: buildSourceStates(), observedAt });

      const timer = setInterval(() => {
        const now = clock();
        sseSend(res, "heartbeat", {
          source: "aggregator",
          freshness: makeFreshness(now),
        });
        sseSend(res, "freshness", { sources: buildSourceStates(), observedAt: now });
      }, expectedIntervalMs);
      req.on("close", () => {
        clearInterval(timer);
        sseClients.delete(res);
      });
      return;
    }

    if (pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ sources: buildSourceStates() }));
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
        if (pthClient && typeof pthClient.start === "function") {
          pthClient.start();
          pthClientStarted = true;
        }
        if (pthClient && typeof pthClient.connectEvents === "function") {
          void pthClient.connectEvents();
        }
        resolve();
      });
    });
  }

  function close() {
    if (pthClient && typeof pthClient.stop === "function") {
      pthClient.stop();
      pthClientStarted = false;
    }
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  return {
    server,
    start,
    collectOnce,
    close,
    snapshot: buildSnapshot,
    /** 供测试/集成读取：当前聚合的 PTH 区间（浏览器可用，无凭据）。 */
    getPthIntervals: () => (pthClient ? aggregator.getIntervals() : []),
    /** 供测试/集成读取：当前来源状态（含 docker/pth-timeline/pth-events）。 */
    getSources: buildSourceStates,
  };
}

// 仅当作为主模块直接执行时启动；import 到测试或其他模块时零副作用。
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  const monitorHost = process.env.MONITOR_HOST ?? "127.0.0.1";
  const monitorPort = Number(process.env.MONITOR_PORT ?? 9090);
  const monitorIntervalMs = Number(process.env.MONITOR_INTERVAL_MS ?? 2000);

  // PTH token 只从服务端 token 文件读取；绝不进入 HTML/SSE/日志。
  let pth = null;
  const pthUrl = process.env.MONITOR_PTH_URL;
  const pthTokenFile = process.env.MONITOR_PTH_TOKEN_FILE;
  if (pthUrl && pthTokenFile) {
    const pthToken = readFileSync(pthTokenFile, "utf8").trim();
    pth = {
      endpoint: pthUrl,
      token: pthToken,
      reconcileMs: Number(process.env.MONITOR_PTH_RECONCILE_MS ?? 5000),
    };
  }

  const monitor = createMonitorServer({
    host: monitorHost,
    port: monitorPort,
    intervalMs: monitorIntervalMs,
    pth,
  });
  await monitor.collectOnce();
  await monitor.start();
  setInterval(() => void monitor.collectOnce(), monitorIntervalMs);
  console.log(`docker-monitor: http://${monitorHost}:${monitorPort}  (interval ${monitorIntervalMs}ms${pth ? ", pth enabled" : ""})`);
}
