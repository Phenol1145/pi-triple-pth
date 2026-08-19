import { describe, it, expect } from "vitest";
import http from "node:http";
import {
  createOperatorConsoleServer,
  type OperatorConsoleServer,
} from "../../packages/framework/src/operator-console/index.js";

const TOKEN = "a".repeat(64);

interface RequestOpts {
  origin?: string;
  host?: string;
  json?: unknown;
  headers?: Record<string, string>;
}

async function request(
  app: OperatorConsoleServer,
  method: string,
  path: string,
  opts: RequestOpts = {},
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

function cookieOf(res: { headers: http.IncomingHttpHeaders }): string {
  const setCookie = res.headers["set-cookie"];
  if (Array.isArray(setCookie)) {
    const sessionCookie = setCookie.find((c) => c.startsWith("ptl-operator="));
    return sessionCookie?.split(";")[0] ?? "";
  }
  return String(setCookie ?? "").split(";")[0] ?? "";
}

function makeApp(overrides: Partial<Parameters<typeof createOperatorConsoleServer>[0]> = {}) {
  return createOperatorConsoleServer({
    host: "127.0.0.1",
    bootstrapToken: TOKEN,
    operatorPrincipalId: "human-local-alice",
    pth: { baseUrl: "http://127.0.0.1:4310" },
    n30: { baseUrl: "http://127.0.0.1:4320" },
    ...overrides,
  });
}

async function bootstrap(app: OperatorConsoleServer, token = TOKEN) {
  await app.listen();
  return request(app, "POST", "/api/session/bootstrap", {
    origin: app.origin,
    json: { token },
  });
}

describe("operator console server request boundaries", () => {
  it("bootstrap 后 GET /api/session 需 cookie；缺 cookie → 401", async () => {
    const app = makeApp();
    try {
      const res = await request(app, "GET", "/api/session");
      expect(res.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("伪造 Origin 的 bootstrap POST → 403", async () => {
    const app = makeApp();
    try {
      const res = await request(app, "POST", "/api/session/bootstrap", {
        origin: "http://evil.example",
        json: { token: TOKEN },
      });
      expect(res.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("伪造 Host 的 bootstrap POST → 403", async () => {
    const app = makeApp();
    try {
      const res = await request(app, "POST", "/api/session/bootstrap", {
        origin: app.origin,
        host: "evil.example",
        json: { token: TOKEN },
      });
      expect(res.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("CSRF 壳：POST /api/session/logout 缺/错 X-PTL-CSRF → 401；正确 → 200 且会话销毁", async () => {
    const app = makeApp();
    try {
      const first = await bootstrap(app);
      expect(first.status).toBe(200);
      const cookie = cookieOf(first);
      expect(cookie).toMatch(/^ptl-operator=/);
      const payload = JSON.parse(first.body);
      const csrf = payload.csrfToken as string;
      expect(csrf).toMatch(/^[0-9a-f]{64}$/);

      const missing = await request(app, "POST", "/api/session/logout", {
        origin: app.origin,
        headers: { cookie },
      });
      expect(missing.status).toBe(401);

      const wrong = await request(app, "POST", "/api/session/logout", {
        origin: app.origin,
        headers: { cookie, "x-ptl-csrf": "b".repeat(64) },
      });
      expect(wrong.status).toBe(401);

      const ok = await request(app, "POST", "/api/session/logout", {
        origin: app.origin,
        headers: { cookie, "x-ptl-csrf": csrf },
      });
      expect(ok.status).toBe(200);

      const after = await request(app, "GET", "/api/session", {
        headers: { cookie },
      });
      expect(after.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("path traversal 不返回文件：未认证 401；认证后 302 到 /#/overview", async () => {
    const app = makeApp();
    try {
      const unauthenticated = await request(app, "GET", "/../etc/passwd");
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.body).not.toContain("root:");

      const first = await bootstrap(app);
      const cookie = cookieOf(first);
      const authenticated = await request(app, "GET", "/../etc/passwd", {
        headers: { cookie },
      });
      expect(authenticated.status).toBe(302);
      expect(authenticated.headers.location).toBe("/#/overview");
      expect(authenticated.body).not.toContain("root:");
    } finally {
      await app.close();
    }
  });

  it("未知 /api/* → JSON 404（不论是否带 cookie）", async () => {
    const app = makeApp();
    try {
      const withoutCookie = await request(app, "GET", "/api/nope");
      expect(withoutCookie.status).toBe(404);
      expect(withoutCookie.headers["content-type"]).toMatch(/application\/json/);
      expect(JSON.parse(withoutCookie.body).error).toBeTruthy();

      const first = await bootstrap(app);
      const cookie = cookieOf(first);
      const withCookie = await request(app, "GET", "/api/nope", {
        headers: { cookie },
      });
      expect(withCookie.status).toBe(404);
      expect(JSON.parse(withCookie.body).error).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("不支持的方法 → 405（GET /api/session/bootstrap）", async () => {
    const app = makeApp();
    try {
      const res = await request(app, "GET", "/api/session/bootstrap");
      expect(res.status).toBe(405);
    } finally {
      await app.close();
    }
  });

  it("静态壳同源返回：/、/styles.css、/app.js 均为 200 且无 CORS 头", async () => {
    const app = makeApp();
    try {
      const index = await request(app, "GET", "/");
      expect(index.status).toBe(200);
      expect(index.headers["content-type"]).toMatch(/text\/html/);
      expect(index.body).toContain("overview");
      expect(index.body).toContain("work");
      expect(index.body).toContain("debug");
      expect(index.body).toContain("memory");
      expect(index.body).toContain("config");
      expect(index.headers["access-control-allow-origin"]).toBeUndefined();

      const css = await request(app, "GET", "/styles.css");
      expect(css.status).toBe(200);
      expect(css.headers["content-type"]).toMatch(/text\/css/);

      const js = await request(app, "GET", "/app.js");
      expect(js.status).toBe(200);
      expect(js.headers["content-type"]).toMatch(/text\/javascript/);
      expect(js.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("idle expiry：会话空闲 30 分钟后 API 返回 401", async () => {
    let now = Date.parse("2026-08-19T00:00:00.000Z");
    const app = makeApp({ clock: () => now });
    try {
      const first = await bootstrap(app);
      expect(first.status).toBe(200);
      const cookie = cookieOf(first);

      const fresh = await request(app, "GET", "/api/session", {
        headers: { cookie },
      });
      expect(fresh.status).toBe(200);

      now += 31 * 60 * 1000;
      const expired = await request(app, "GET", "/api/session", {
        headers: { cookie },
      });
      expect(expired.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("cookie replay after restart：新 server 实例拒绝旧会话 cookie → 401", async () => {
    const app1 = makeApp();
    let cookie = "";
    try {
      const first = await bootstrap(app1);
      cookie = cookieOf(first);
      expect(cookie).toMatch(/^ptl-operator=/);
    } finally {
      await app1.close();
    }

    const app2 = makeApp();
    try {
      const replay = await request(app2, "GET", "/api/session", {
        headers: { cookie },
      });
      expect(replay.status).toBe(401);
    } finally {
      await app2.close();
    }
  });

  it("非 loopback bind 无显式配置即 fail-closed：缺省 host 为 127.0.0.1，显式非 loopback 抛错", async () => {
    const app = makeApp({ host: undefined });
    try {
      await app.listen();
      expect(app.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(app.hostHeader).toMatch(/^127\.0\.0\.1:/);
    } finally {
      await app.close();
    }

    for (const host of ["0.0.0.0", "::", "localhost"]) {
      expect(() => makeApp({ host })).toThrow(/127\.0\.0\.1/);
    }
  });
});
