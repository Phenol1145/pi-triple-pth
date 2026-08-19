import { describe, it, expect } from "vitest";
import http from "node:http";
import {
  createOperatorConsoleServer,
  type OperatorConsoleServer,
} from "../../packages/framework/src/operator-console/index.js";

const TOKEN = "a".repeat(64);

/** 用 node:http 直连 loopback server，以便精确控制 Origin/Host 头。 */
async function request(
  app: OperatorConsoleServer,
  method: string,
  path: string,
  opts: {
    origin?: string;
    host?: string;
    json?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  await app.listen();
  const { port } = app;
  const body = opts.json === undefined ? undefined : JSON.stringify(opts.json);
  const headers: Record<string, string> = {
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...(opts.headers ?? {}),
  };
  if (opts.origin !== undefined) headers.origin = opts.origin;
  headers.host = opts.host ?? `127.0.0.1:${port}`;

  return await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { raw += chunk; });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function bootstrap(app: OperatorConsoleServer, token = TOKEN) {
  await app.listen();
  return request(app, "POST", "/api/session/bootstrap", {
    origin: app.origin,
    json: { token },
  });
}

describe("operator console one-time bootstrap", () => {
  it("首次 bootstrap：64 字符 token → 200 + Set-Cookie 含 HttpOnly 与 SameSite=Strict", async () => {
    const app = createOperatorConsoleServer({
      host: "127.0.0.1",
      bootstrapToken: TOKEN,
      operatorPrincipalId: "human-local-alice",
      pth: { baseUrl: "http://127.0.0.1:4310" },
      n30: { baseUrl: "http://127.0.0.1:4320" },
    });
    try {
      const res = await bootstrap(app);
      expect(res.status).toBe(200);

      const setCookie = res.headers["set-cookie"];
      const cookie = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie ?? "");
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/HttpOnly.*SameSite=Strict/);
      // 纯 HTTP loopback 上不得声称 Secure（未来 TLS profile 才允许 __Host- 前缀）
      expect(cookie).not.toMatch(/Secure/);
      expect(cookie).not.toContain("__Host-");

      const payload = JSON.parse(res.body);
      expect(payload.ok).toBe(true);
      expect(payload.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await app.close();
    }
  });

  it("重放同一个 bootstrap token → 401（一次性）", async () => {
    const app = createOperatorConsoleServer({
      host: "127.0.0.1",
      bootstrapToken: TOKEN,
      operatorPrincipalId: "human-local-alice",
      pth: { baseUrl: "http://127.0.0.1:4310" },
      n30: { baseUrl: "http://127.0.0.1:4320" },
    });
    try {
      const first = await bootstrap(app);
      expect(first.status).toBe(200);

      const replay = await bootstrap(app);
      expect(replay.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("错误 bootstrap token → 401", async () => {
    const app = createOperatorConsoleServer({
      host: "127.0.0.1",
      bootstrapToken: TOKEN,
      operatorPrincipalId: "human-local-alice",
      pth: { baseUrl: "http://127.0.0.1:4310" },
      n30: { baseUrl: "http://127.0.0.1:4320" },
    });
    try {
      const wrong = "b".repeat(64);
      expect(wrong).not.toBe(TOKEN);
      const res = await bootstrap(app, wrong);
      expect(res.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("非 loopback host → 创建即拒绝（fail-closed）", () => {
    for (const host of ["0.0.0.0", "localhost", "::", "192.168.1.10"]) {
      expect(
        () => createOperatorConsoleServer({
          host,
          bootstrapToken: TOKEN,
          operatorPrincipalId: "human-local-alice",
          pth: { baseUrl: "http://127.0.0.1:4310" },
          n30: { baseUrl: "http://127.0.0.1:4320" },
        }),
      ).toThrow(/127\.0\.0\.1/);
    }
  });
});
