/**
 * e2e/operator-server.ts — Playwright 专用 loopback console + fake PTH 上游。
 * 仅测试使用；bootstrap token 固定、全部数据为固定 fake。
 */

import http from "node:http";
import { createOperatorConsoleServer } from "../dist/operator-console/index.js";

const TOKEN = "e".repeat(64);
const PTH_TOKEN = "playwright-fake-pth-token";
const PORT = 3197;
const PTH_PORT = 3198;
const N30_PORT = 3199;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

const memoryItem = {
  id: "idx:lean:list-map",
  kind: "symbol-index",
  status: "official",
  anchors: ["lean"],
  memoryType: "index",
  version: 2,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T01:00:00.000Z",
  contentBytes: 512,
};

const fakePth = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake-pth");
  if (req.headers.authorization !== `Bearer ${PTH_TOKEN}`) {
    send(res, 401, { error: "unauthorized" });
    return;
  }
  if (url.pathname === "/api/v1/observe/workers") {
    send(res, 200, [{
      workerId: "worker-a",
      batchId: "batch-1",
      role: { roleId: "lean4-prover", revision: "rev-9" },
      lifecycle: "busy",
      workMode: "run",
      currentTaskId: "task-1",
      leaseId: "lease-1",
      heartbeatLagMs: 42,
      regionIds: ["memory:wiki"],
      regionWeights: { "memory:wiki": 1 },
      workingSet: {
        entryIds: ["idx:lean:list-map"],
        skillIndexIds: ["skill:prove:v1"],
        activeSkillIds: [],
        counts: { memoryEntries: 1, skillIndexEntries: 1, activeSkills: 0, tools: 1 },
        usage: { memoryEntries: 1, memoryChars: 10, skillIndexEntries: 1, activeSkills: 0, skillChars: 10, tools: 1 },
        omitted: {},
      },
      toolNames: ["memory"],
      skillIds: ["skill:prove:v1"],
    }]);
    return;
  }
  if (url.pathname === "/api/v1/observe/memory/summary") {
    send(res, 200, { byType: { index: { count: 6, bytes: 20 }, wiki: { count: 3, bytes: 90 }, setting: { count: 0, bytes: 0 }, skill: { count: 0, bytes: 0 }, log: { count: 0, bytes: 0 } }, totals: { count: 9, bytes: 110 } });
    return;
  }
  if (url.pathname === "/api/v1/observe/memory/entries") {
    send(res, 200, { items: [memoryItem], nextCursor: null, scope: { tenantId: "tenant-a" }, collectedAt: 1 });
    return;
  }
  if (url.pathname === `/api/v1/observe/memory/entries/${memoryItem.id}`) {
    send(res, 200, memoryItem);
    return;
  }
  if (url.pathname === `/api/v1/observe/memory/entries/${memoryItem.id}/revisions`) {
    send(res, 200, { entryId: memoryItem.id, revisions: [{ entryId: memoryItem.id, revision: 2, status: "official", createdAt: "2026-08-21T01:00:00.000Z", reason: "promote" }] });
    return;
  }
  if (url.pathname === "/api/v1/observe/config") {
    send(res, 200, [
      { key: "DATABASE_URL", group: "db", type: "string", scope: "both", description: "db url", secret: true, runtime: true, source: "env", effectiveValue: "***", defaultValue: "***" },
      { key: "PORT", group: "server", type: "number", scope: "global", description: "port", secret: false, runtime: false, source: "default", effectiveValue: "8080", defaultValue: "8080" },
    ]);
    return;
  }
  if (url.pathname === "/api/v1/observe/roles") {
    send(res, 200, [{ roleId: "lean4-prover", revision: "rev-7", parent: "solver", generation: 5, tags: ["formal"], capabilities: ["memory"], thinking: "medium", acceptanceRole: "read-only" }]);
    return;
  }
  send(res, 404, { error: "not found" });
});

await new Promise<void>((resolve) => fakePth.listen(PTH_PORT, "127.0.0.1", resolve));

const fakeN30 = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    snapshotId: "e2e-snapshot",
    collectedAt: 1_780_000_000_000,
    window: { from: 1_779_999_000_000, to: 1_780_000_000_000 },
    summary: { running: 2, completed: 1, total: 3, alerts: [] },
    intervals: [
      { id: "iv-1", kind: "task", status: "running", startAt: 1_779_999_000_000, endAt: null },
    ],
    samples: [],
    sources: [{ source: "docker", state: "fresh" }, { source: "pth-timeline", state: "fresh" }],
  }));
});
await new Promise<void>((resolve) => fakeN30.listen(N30_PORT, "127.0.0.1", resolve));

const app = createOperatorConsoleServer({
  host: "127.0.0.1",
  port: PORT,
  bootstrapToken: TOKEN,
  operatorPrincipalId: "playwright-operator",
  tenant: "tenant-a",
  space: "default",
  pth: { baseUrl: `http://127.0.0.1:${PTH_PORT}`, token: PTH_TOKEN },
  n30: { baseUrl: `http://127.0.0.1:${N30_PORT}` },
});
await app.listen();
console.log(`operator e2e ready at ${app.origin} token=${TOKEN}`);
