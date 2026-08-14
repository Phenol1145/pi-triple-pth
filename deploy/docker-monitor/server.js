#!/usr/bin/env node
/**
 * docker-monitor —— 轻量容器监控面板服务端（G 阶段）
 *
 * 数据源：Docker Engine API（unix socket /var/run/docker.sock——本机直连，零依赖）
 *   - GET /containers/json?all=true         容器列表
 *   - GET /containers/:id/stats?stream=false 实时快照（CPU/内存/网络）
 * 推送：SSE（text/event-stream）——2s 全量快照，前端 EventSource 订阅
 * 使用：node tools/docker-monitor/server.js  → http://localhost:9090
 *
 * 只读监控（不提供容器管理操作）。解析逻辑见 parse*.ts（可单测）。
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getContainers, getContainerStats } from "./docker-api.js";
import { computeMetrics } from "./metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MONITOR_PORT ?? 9090);
const INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS ?? 2000);

// ── 采集循环：容器列表 + running 容器 stats 快照（维护 prev 帧算 CPU%） ──
let snapshot = { ts: Date.now(), containers: [] };
/** @type {Map<string, Record<string, unknown>>} 每容器上一帧 stats（CPU% 两帧差） */
const prevStats = new Map();

async function collect() {
  try {
    const list = await getContainers();
    const containers = [];
    for (const c of list) {
      const entry = {
        id: c.Id?.slice(0, 12) ?? "?",
        names: (c.Names ?? []).map((n) => n.replace(/^\//, "")).join(","),
        image: (c.Image ?? "").split("@")[0],
        state: c.State ?? "?",
        status: c.Status ?? "",
        ports: (c.Ports ?? []).map((p) => `${p.IP ?? ""}:${p.PublicPort ?? ""}->${p.PrivatePort ?? ""}/${p.Type ?? ""}`).filter(Boolean),
      };
      if (c.State === "running" && c.Id) {
        try {
          const raw = await getContainerStats(c.Id);
          const m = computeMetrics(raw, c.Id, prevStats.get(c.Id));
          prevStats.set(c.Id, raw); // 存本帧供下轮差值
          entry.cpu = m.cpuPct;
          entry.mem = m.memUsage;
          entry.memLimit = m.memLimit;
          entry.memPct = m.memPct;
          entry.netRx = m.netRx;
          entry.netTx = m.netTx;
          entry.health = c.Health?.Status;
        } catch {
          entry.cpu = null; // stats 拉取失败（瞬时）——保留列表可见
        }
      } else {
        prevStats.delete(c.Id); // 非 running——清 prev（重启后第一帧不误差）
      }
      containers.push(entry);
    }
    // 清理已消失容器的 prev 帧
    const ids = new Set(list.map((c) => c.Id));
    for (const id of prevStats.keys()) {
      if (!ids.has(id)) prevStats.delete(id);
    }
    snapshot = { ts: Date.now(), containers };
  } catch (err) {
    snapshot = { ts: Date.now(), error: err instanceof Error ? err.message : String(err), containers: [] };
  }
}

// ── HTTP 服务 ──────────────────────────────────────────────────
const html = readFileSync(join(__dirname, "index.html"), "utf8");

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    const timer = setInterval(() => {
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    }, INTERVAL_MS);
    req.on("close", () => clearInterval(timer));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

// 启动：先采集一轮再 listen
await collect();
setInterval(() => void collect(), INTERVAL_MS);
server.listen(PORT, () => {
  console.log(`docker-monitor: http://localhost:${PORT}  (interval ${INTERVAL_MS}ms)`);
});
