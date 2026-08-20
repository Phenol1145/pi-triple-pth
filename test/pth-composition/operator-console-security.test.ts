/**
 * operator-console-security.test.ts — N33 Task 9 安全破坏矩阵。
 * 真实 loopback operator console server + fake PTH/N30；每类破坏只翻转其映射门。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import {
  createOperatorConsoleServer,
  type OperatorConsoleServer,
} from "../../packages/pth-console/src/operator-console/index.js";

const BOOTSTRAP_TOKEN = "f".repeat(64);
const PTH_TOKEN = "pth-security-secret-token-0123456789abcdef";

function buildFakePth() {
  return http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${PTH_TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [] }));
  });
}

describe("operator console security", () => {
  let pthServer: http.Server;
  let consoleServer: OperatorConsoleServer;
  let baseUrl = "";
  let cookie = "";
  let csrfToken = "";

  beforeAll(async () => {
    pthServer = buildFakePth();
    await new Promise<void>((r) => pthServer.listen(0, "127.0.0.1", r));
    const pthPort = (pthServer.address() as { port: number }).port;
    consoleServer = createOperatorConsoleServer({
      host: "127.0.0.1",
      bootstrapToken: BOOTSTRAP_TOKEN,
      operatorPrincipalId: "human-local-alice",
      pth: { baseUrl: `http://127.0.0.1:${pthPort}`, token: PTH_TOKEN },
      n30: { baseUrl: "http://127.0.0.1:1" },
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
    const bootBody = (await res.json()) as { csrfToken?: string };
    csrfToken = bootBody.csrfToken ?? "";
    expect(csrfToken.length).toBeGreaterThan(16);
  }, 60_000);

  afterAll(async () => {
    await consoleServer.close();
    await new Promise<void>((r) => pthServer.close(() => r()));
  });

  it("bootstrap 一次性：重放同一 token → 401", async () => {
    const replay = await fetch(`${baseUrl}/api/session/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", host: consoleServer.hostHeader, origin: baseUrl },
      body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
    });
    expect(replay.status).toBe(401);
  });

  it("伪造 Host / 外部 Origin / 缺失 CSRF 全部拒绝", async () => {
    const forgedHost = await fetch(`${baseUrl}/api/work/preview`, {
      method: "POST",
      headers: { cookie, host: "evil.example", origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ mode: "run" }),
    });
    expect([401, 403, 405]).toContain(forgedHost.status);

    const foreignOrigin = await fetch(`${baseUrl}/api/work/preview`, {
      method: "POST",
      headers: { cookie, host: consoleServer.hostHeader, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ mode: "run" }),
    });
    expect([401, 403, 405]).toContain(foreignOrigin.status);

    const missingCsrf = await fetch(`${baseUrl}/api/work/preview`, {
      method: "POST",
      headers: { cookie, host: consoleServer.hostHeader, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ mode: "run" }),
    });
    expect([401, 403]).toContain(missingCsrf.status);
  });

  it("未知 adapter / shell 字段 / 任意 HTTP 路径 fail-closed", async () => {
    const csrfHeader = { "x-ptl-csrf": csrfToken };
    const unknown = await fetch(`${baseUrl}/api/work/preview`, {
      method: "POST",
      headers: { cookie, host: consoleServer.hostHeader, origin: baseUrl, "content-type": "application/json", ...csrfHeader },
      body: JSON.stringify({ mode: "run", action: "http.request", input: {} }),
    });
    expect([400, 404]).toContain(unknown.status);

    const shell = await fetch(`${baseUrl}/api/work/preview`, {
      method: "POST",
      headers: { cookie, host: consoleServer.hostHeader, origin: baseUrl, "content-type": "application/json", ...csrfHeader },
      body: JSON.stringify({ mode: "run", action: "task.publish", input: { command: "rm -rf /", shell: "/bin/sh" } }),
    });
    expect([400, 404, 422]).toContain(shell.status);

    const arbitrary = await fetch(`${baseUrl}/api/nonexistent-${Math.random()}`, {
      headers: { cookie, host: consoleServer.hostHeader },
    });
    expect(arbitrary.status).toBe(404);
  });

  it("浏览器载荷零凭据泄漏：HTML/JS/API 响应不含 PTH token 或 Docker socket", async () => {
    const page = await fetch(`${baseUrl}/`, { headers: { cookie, host: consoleServer.hostHeader } });
    const pageText = await page.text();
    expect(pageText).not.toContain(PTH_TOKEN);
    expect(pageText).not.toContain("/var/run/docker.sock");
    const app = await fetch(`${baseUrl}/app.js`, { headers: { cookie, host: consoleServer.hostHeader } });
    const appText = await app.text();
    expect(appText).not.toContain(PTH_TOKEN);
    expect(appText).not.toContain("/var/run/docker.sock");
  });

  it("N30 代理拒绝 POST（只读代理门）", async () => {
    const post = await fetch(`${baseUrl}/observe/snapshot`, {
      method: "POST",
      headers: { cookie, host: consoleServer.hostHeader },
      body: "{}",
    });
    expect(post.status).toBe(403);
  });
});
