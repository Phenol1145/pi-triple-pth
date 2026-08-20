/**
 * operator-console-worker-debug.integration.test.ts — N33 Task 6 组合集成。
 *
 * 真实 PTL operator console server（loopback）+ fake PTH workers 端点：
 *  - GET /api/debug/workers 返回只读投影（WorkerInspection 面）；
 *  - POST 一律 405/404，零控制调用；
 *  - 任何响应体/页面不含 PTH token 或 secret 面。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import {
  createOperatorConsoleServer,
  type OperatorConsoleServer,
} from "../../packages/framework/src/operator-console/index.js";

const BOOTSTRAP_TOKEN = "c".repeat(64);
const PTH_TOKEN = "pth-debug-secret-token-0123456789abcdef";

function buildFakePth(calls: { count: number }) {
  return http.createServer((req, res) => {
    void req;
    if (req.method === "GET" && req.url === "/api/v1/observe/workers") {
      if (req.headers.authorization !== `Bearer ${PTH_TOKEN}`) {
        res.writeHead(401).end(JSON.stringify({ error: "bad auth" }));
        return;
      }
      calls.count += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([
        {
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
            counts: { memoryEntries: 1, skillIndexEntries: 1, activeSkills: 0, tools: 2 },
            usage: { memoryEntries: 1, memoryChars: 10, skillIndexEntries: 1, activeSkills: 0, skillChars: 10, tools: 2 },
            omitted: {},
          },
          toolNames: ["probe", "check"],
          skillIds: ["skill:prove:v1"],
        },
      ]));
      return;
    }
    res.writeHead(404).end();
  });
}

describe("operator console worker debug integration", () => {
  let pthServer: http.Server;
  let consoleServer: OperatorConsoleServer;
  let baseUrl = "";
  let cookie = "";
  const calls = { count: 0 };

  beforeAll(async () => {
    pthServer = buildFakePth(calls);
    await new Promise<void>((resolveListen) => pthServer.listen(0, "127.0.0.1", resolveListen));
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

    // 一次性 bootstrap：全部用例共享同一会话 cookie。
    const res = await fetch(`${baseUrl}/api/session/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", host: consoleServer.hostHeader, origin: baseUrl },
      body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly.*SameSite=Strict/);
    cookie = setCookie.split(";")[0]!;
  }, 60_000);

  afterAll(async () => {
    await consoleServer.close();
    await new Promise<void>((resolveClose) => pthServer.close(() => resolveClose()));
  });

  it("GET /api/debug/workers 经会话返回只读投影，响应无 token/secret", async () => {
    const res = await fetch(`${baseUrl}/api/debug/workers`, {
      headers: { cookie, host: consoleServer.hostHeader, origin: baseUrl },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("worker-a");
    expect(body).toContain("lean4-prover");
    expect(body).toContain("memory:wiki");
    expect(body).toContain("idx:lean:list-map");
    expect(body).not.toContain(PTH_TOKEN);
    expect(body).not.toContain("chainOfThought");
    expect(body).not.toContain("secret");
    expect(calls.count).toBeGreaterThanOrEqual(1);
  });

  it("未认证 GET 401；POST /api/debug/workers 405；其他 /api/debug/* POST 404", async () => {
    const unauth = await fetch(`${baseUrl}/api/debug/workers`, { headers: { host: consoleServer.hostHeader } });
    expect(unauth.status).toBe(401);

    const post = await fetch(`${baseUrl}/api/debug/workers`, {
      method: "POST",
      headers: { cookie, host: consoleServer.hostHeader, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
    expect(post.status).toBe(405);

    const unknown = await fetch(`${baseUrl}/api/debug/anything`, {
      method: "POST",
      headers: { cookie, host: consoleServer.hostHeader, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    });
    expect(unknown.status).toBe(404);
  });

  it("debug 页只读：请求任何控制动作都不会到达 PTH", async () => {
    const before = calls.count;
    for (const path of ["/api/debug/workers", "/api/debug/workers/pause", "/api/debug/workers/worker-a/resume"]) {
      await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { cookie, host: consoleServer.hostHeader, origin: baseUrl, "content-type": "application/json" },
        body: JSON.stringify({ workerId: "worker-a" }),
      });
    }
    expect(calls.count).toBe(before);
  });
});
