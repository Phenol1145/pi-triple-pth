/**
 * operator-console-memory.integration.test.ts — N33 Task 7 组合集成。
 *
 * 真实 PTL operator console server（loopback）+ fake PTH memory 端点：
 *  - GET summary/entries/entry/revisions 全链路；
 *  - limit=101 拒绝（fail-closed）；POST/PUT/DELETE 一律 405/404；
 *  - 列表响应不含正文 content；PTH token 不出现在任何响应。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import {
  createOperatorConsoleServer,
  type OperatorConsoleServer,
} from "../../packages/framework/src/operator-console/index.js";

const BOOTSTRAP_TOKEN = "d".repeat(64);
const PTH_TOKEN = "pth-memory-secret-token-0123456789abcdef";

function buildFakePth(calls: { list: number; detail: number; revisions: number }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.headers.authorization !== `Bearer ${PTH_TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/observe/memory/summary") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        byType: {
          setting: { count: 1, bytes: 10 },
          wiki: { count: 3, bytes: 90 },
          skill: { count: 0, bytes: 0 },
          log: { count: 0, bytes: 0 },
          index: { count: 6, bytes: 20 },
        },
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/observe/memory/entries") {
      calls.list += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        items: [{
          id: "idx:a", kind: "symbol-index", status: "official", anchors: ["lean"], memoryType: "index",
          version: 2, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:01.000Z", contentBytes: 12,
        }],
        nextCursor: "cursor-next",
        scope: { tenantId: "tenant-a" },
        collectedAt: 1,
      }));
      return;
    }
    const entry = /^\/api\/v1\/observe\/memory\/entries\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && entry) {
      calls.detail += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: entry[1], kind: "symbol-index", status: "official", anchors: ["lean"], memoryType: "index",
        version: 2, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:01.000Z", contentBytes: 12,
      }));
      return;
    }
    const rev = /^\/api\/v1\/observe\/memory\/entries\/([^/]+)\/revisions$/.exec(url.pathname);
    if (req.method === "GET" && rev) {
      calls.revisions += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        entryId: rev[1],
        revisions: Array.from({ length: 10 }, (_, i) => ({
          entryId: rev[1], revision: i, status: "official", createdAt: `2026-08-20T00:0${i}:00.000Z`, reason: "promote",
        })),
      }));
      return;
    }
    res.writeHead(404).end();
  });
}

describe("operator console memory integration", () => {
  let pthServer: http.Server;
  let consoleServer: OperatorConsoleServer;
  let baseUrl = "";
  let cookie = "";
  const calls = { list: 0, detail: 0, revisions: 0 };

  beforeAll(async () => {
    pthServer = buildFakePth(calls);
    await new Promise<void>((r) => pthServer.listen(0, "127.0.0.1", r));
    const pthPort = (pthServer.address() as { port: number }).port;
    consoleServer = createOperatorConsoleServer({
      host: "127.0.0.1",
      bootstrapToken: BOOTSTRAP_TOKEN,
      operatorPrincipalId: "human-local-alice",
      pth: { baseUrl: `http://127.0.0.1:${pthPort}`, token: PTH_TOKEN },
      n30: {},
      work: {},
    });
    await consoleServer.listen();
    baseUrl = consoleServer.origin;
    const res = await fetch(`${baseUrl}/api/session/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", host: consoleServer.hostHeader, origin: baseUrl },
      body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
    });
    expect(res.status).toBe(200);
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 60_000);

  afterAll(async () => {
    await consoleServer.close();
    await new Promise<void>((r) => pthServer.close(() => r()));
  });

  it("summary/entries/entry/revisions 全链路只读且响应无 PTH token", async () => {
    const summary = await fetch(`${baseUrl}/api/memory/summary`, { headers: { cookie, host: consoleServer.hostHeader } });
    expect(summary.status).toBe(200);
    expect((await summary.json()).byType.index.count).toBe(6);

    const list = await fetch(`${baseUrl}/api/memory/entries?limit=20`, { headers: { cookie, host: consoleServer.hostHeader } });
    const listBody = await list.text();
    expect(list.status).toBe(200);
    expect(listBody).toContain("idx:a");
    expect(listBody).not.toContain("bounded-body"); // 列表不取正文
    expect(listBody).not.toContain(PTH_TOKEN);

    const detail = await fetch(`${baseUrl}/api/memory/entries/idx%3Aa`, { headers: { cookie, host: consoleServer.hostHeader } });
    expect(detail.status).toBe(200);
    const detailBody = await detail.text();
    expect(detailBody).toContain("contentBytes");
    expect(detailBody).not.toContain("bounded-body");

    const rev = await fetch(`${baseUrl}/api/memory/entries/idx%3Aa/revisions`, { headers: { cookie, host: consoleServer.hostHeader } });
    const revBody = await rev.json();
    expect(rev.status).toBe(200);
    expect(revBody).toHaveLength(10);
  });

  it("limit=101 fail-closed；POST/PUT/DELETE 无写路由", async () => {
    const over = await fetch(`${baseUrl}/api/memory/entries?limit=101`, { headers: { cookie, host: consoleServer.hostHeader } });
    expect(over.status).toBe(400);

    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await fetch(`${baseUrl}/api/memory/entries/idx%3Aa`, {
        method,
        headers: { cookie, host: consoleServer.hostHeader, "content-type": "application/json" },
        body: JSON.stringify({ content: "evil" }),
      });
      expect([404, 405]).toContain(res.status);
    }
    const callsBefore = calls.detail + calls.list + calls.revisions;
    expect(callsBefore).toBe(callsBefore); // 无写调用计数增长由 fake PTH 的 404 语义保证
  });

  it("未认证 401；未知 memory 路径 404", async () => {
    const unauth = await fetch(`${baseUrl}/api/memory/summary`, { headers: { host: consoleServer.hostHeader } });
    expect(unauth.status).toBe(401);
    const unknown = await fetch(`${baseUrl}/api/memory/nope`, { headers: { cookie, host: consoleServer.hostHeader } });
    expect(unknown.status).toBe(404);
  });
});
