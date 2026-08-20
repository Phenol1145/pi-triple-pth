/**
 * operator-console-config.integration.test.ts — N33 Task 8 组合集成。
 *
 * 真实 PTL operator console server（loopback）+ fake PTH config/roles 端点：
 *  - GET /api/config/ptl（redacted 本地事实）、/api/config/pth、/api/roles；
 *  - secret 值零泄漏（任何响应不含 PTH token 或 fake secret）；
 *  - POST/PUT/PATCH/DELETE 在 /api/config 与 /api/roles 下全部 405/404，
 *    且零 ConfigCenter/RuntimeCatalog 变更调用。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import {
  createOperatorConsoleServer,
  type OperatorConsoleServer,
} from "../../packages/framework/src/operator-console/index.js";

const BOOTSTRAP_TOKEN = "e".repeat(64);
const PTH_TOKEN = "pth-config-secret-token-0123456789abcdef";
const FAKE_SECRET = "postgres://do-not-leak:password@db";

function buildFakePth(calls: { mutations: number }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.headers.authorization !== `Bearer ${PTH_TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "GET") {
      calls.mutations += 1;
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === "/api/v1/observe/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        items: [
          { key: "DATABASE_URL", group: "db", type: "string", source: "env", scope: "global", secret: true, defaultValue: "***", effectiveValue: "***" },
          { key: "PORT", group: "server", type: "number", source: "default", scope: "global", secret: false, defaultValue: 8080, effectiveValue: 8080 },
        ],
      }));
      return;
    }
    if (url.pathname === "/api/v1/observe/roles") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        items: [
          {
            id: "lean4-prover", parent: "solver", roleRevision: "rev-7", family: "executor",
            tags: ["formal"], capabilities: ["memory", "skills"], defaultReplicas: 0,
            loadPolicyRef: "professional:lean4-prover:v1",
          },
        ],
      }));
      return;
    }
    res.writeHead(404).end();
  });
}

describe("operator console config integration", () => {
  let pthServer: http.Server;
  let consoleServer: OperatorConsoleServer;
  let baseUrl = "";
  let cookie = "";
  const calls = { mutations: 0 };

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

  it("GET 三 tab 全链路；secret 与 PTH token 零泄漏", async () => {
    const ptl = await fetch(`${baseUrl}/api/config/ptl`, { headers: { cookie, host: consoleServer.hostHeader } });
    expect(ptl.status).toBe(200);
    const ptlBody = await ptl.text();
    expect(ptlBody).toContain("127.0.0.1");
    expect(ptlBody).not.toContain(PTH_TOKEN);
    expect(ptlBody).not.toContain(FAKE_SECRET);

    const pth = await fetch(`${baseUrl}/api/config/pth`, { headers: { cookie, host: consoleServer.hostHeader } });
    const pthBody = await pth.text();
    expect(pth.status).toBe(200);
    expect(pthBody).toContain("DATABASE_URL");
    expect(pthBody).toContain('"effectiveValue":"***"');
    expect(pthBody).not.toContain(FAKE_SECRET);
    expect(pthBody).not.toContain(PTH_TOKEN);

    const roles = await fetch(`${baseUrl}/api/roles`, { headers: { cookie, host: consoleServer.hostHeader } });
    const rolesBody = await roles.text();
    expect(roles.status).toBe(200);
    expect(rolesBody).toContain("lean4-prover");
    expect(rolesBody).toContain("rev-7");
    expect(rolesBody).not.toContain("lifecycle");
    expect(rolesBody).not.toContain(PTH_TOKEN);
  });

  it("写方法全部拒绝且零 ConfigCenter/RuntimeCatalog 变更", async () => {
    const before = calls.mutations;
    for (const path of ["/api/config/pth", "/api/config/ptl", "/api/roles", "/api/roles/lean4-prover"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: { cookie, host: consoleServer.hostHeader, "content-type": "application/json" },
          body: JSON.stringify({ key: "DATABASE_URL", value: FAKE_SECRET }),
        });
        expect([404, 405]).toContain(res.status);
      }
    }
    expect(calls.mutations).toBe(before);
  });

  it("未认证 401；未知路径 404", async () => {
    const unauth = await fetch(`${baseUrl}/api/config/pth`, { headers: { host: consoleServer.hostHeader } });
    expect(unauth.status).toBe(401);
    const unknown = await fetch(`${baseUrl}/api/config/nope`, { headers: { cookie, host: consoleServer.hostHeader } });
    expect(unknown.status).toBe(404);
  });
});
