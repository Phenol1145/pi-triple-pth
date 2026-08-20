import { describe, it, expect } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createOperatorConsoleServer,
  type OperatorConsoleServer,
} from "../../packages/pth-console/src/operator-console/index.js";
import {
  createN30ReadOnlyProxy,
  N30_READ_ONLY_PATHS,
} from "../../packages/pth-console/src/operator-console/n30-proxy.js";

const TOKEN = "a".repeat(64);

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface RawRequestOpts {
  origin?: string;
  json?: unknown;
  headers?: Record<string, string>;
}

async function rawRequest(
  app: OperatorConsoleServer,
  method: string,
  path: string,
  opts: RawRequestOpts = {},
): Promise<RawResponse> {
  await app.listen();
  const { port } = app;
  const body = opts.json === undefined ? undefined : JSON.stringify(opts.json);
  const headers: Record<string, string> = {
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...(opts.headers ?? {}),
  };
  if (opts.origin !== undefined) headers.origin = opts.origin;
  headers.host = `127.0.0.1:${port}`;

  return await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
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

function cookieOf(res: RawResponse): string {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie ?? "")];
  const sessionCookie = cookies.find((c) => c.startsWith("ptl-operator="));
  return sessionCookie?.split(";")[0] ?? "";
}

function makeApp(n30BaseUrl: string): OperatorConsoleServer {
  return createOperatorConsoleServer({
    host: "127.0.0.1",
    bootstrapToken: TOKEN,
    operatorPrincipalId: "human-local-alice",
    pth: { baseUrl: "http://127.0.0.1:4310" },
    n30: { baseUrl: n30BaseUrl },
  });
}

async function bootstrap(app: OperatorConsoleServer): Promise<string> {
  await app.listen();
  const res = await rawRequest(app, "POST", "/api/session/bootstrap", {
    origin: app.origin,
    json: { token: TOKEN },
  });
  expect(res.status).toBe(200);
  const cookie = cookieOf(res);
  expect(cookie).toMatch(/^ptl-operator=/);
  return cookie;
}

async function listenUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function readFirstSseEvent(
  port: number,
  path: string,
  cookie: string,
): Promise<{ event?: string; data?: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { cookie },
    signal: AbortSignal.timeout(3000),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const idx = buf.indexOf("\n\n");
      if (idx >= 0) {
        const block = buf.slice(0, idx);
        const ev: { event?: string; data?: string } = {};
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) ev.event = line.slice(6).trim();
          else if (line.startsWith("data:")) ev.data = line.slice(5).trim();
        }
        return ev;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return {};
}

describe("operator console N30 read-only same-origin proxy", () => {
  it("只读路径白名单 fail-closed：恰好三个路径，且拒绝非 loopback 上游", () => {
    expect(N30_READ_ONLY_PATHS).toEqual(["/observe/", "/observe/snapshot", "/observe/events"]);
    expect(() => createN30ReadOnlyProxy({ baseUrl: "http://169.254.169.254:9090" })).toThrow(
      /loopback|127\.0\.0\.1/,
    );
    expect(() => createN30ReadOnlyProxy({ baseUrl: "http://127.0.0.1:4320" })).not.toThrow();
  });

  it("GET /observe/snapshot 放行，并剥离上游 set-cookie/connection/proxy 响应头", async () => {
    const upstream = await listenUpstream((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": "n30-secret=should-not-leak; Path=/; HttpOnly",
        connection: "close",
        "x-forwarded-for": "10.0.0.1",
        "proxy-authenticate": "Basic",
      });
      res.end(JSON.stringify({ ok: true, intervals: [], samples: [], sources: [] }));
    });
    const app = makeApp(upstream.baseUrl);
    try {
      const cookie = await bootstrap(app);
      const res = await rawRequest(app, "GET", "/observe/snapshot", {
        headers: { cookie, authorization: "Bearer browser-secret" },
      });

      expect(res.status).toBe(200);
      expect(res.headers["set-cookie"]).toBeUndefined();
      // 上游 connection: close 不被转发；Node 自身生成的 keep-alive 连接管理头是安全的。
      expect(res.headers["connection"]).not.toBe("close");
      expect(res.headers["connection"]).not.toBe("upgrade");
      expect(res.headers["x-forwarded-for"]).toBeUndefined();
      expect(res.headers["proxy-authenticate"]).toBeUndefined();
      const body = JSON.parse(res.body) as { ok: boolean; sources: unknown[] };
      expect(body.ok).toBe(true);
      expect(res.body).not.toContain("should-not-leak");
      expect(res.body).not.toContain(upstream.baseUrl);
    } finally {
      await app.close();
      await upstream.close();
    }
  });

  it("GET /observe/events 放行 SSE 且不泄漏凭据", async () => {
    const upstream = await listenUpstream((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "set-cookie": "n30-secret=should-not-leak; Path=/",
      });
      res.write('id: 1\nevent: heartbeat\ndata: {"ok":true}\n\n');
    });
    const app = makeApp(upstream.baseUrl);
    try {
      const cookie = await bootstrap(app);
      const ev = await readFirstSseEvent(app.port, "/observe/events", cookie);

      expect(ev.event).toBe("heartbeat");
      expect(ev.data).toContain('"ok":true');
    } finally {
      await app.close();
      await upstream.close();
    }
  });

  it("写方法与未知路径 fail-closed：POST → 403；路径后缀/未知 /observe 路径 → 404", async () => {
    const upstream = await listenUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const app = makeApp(upstream.baseUrl);
    try {
      const cookie = await bootstrap(app);

      for (const path of N30_READ_ONLY_PATHS) {
        const res = await rawRequest(app, "POST", path, {
          origin: app.origin,
          headers: { cookie, "x-ptl-csrf": "b".repeat(64) },
        });
        expect(res.status).toBe(403);
        expect(res.body).toContain("READ_ONLY");
      }

      const suffix = await rawRequest(app, "GET", "/observe/snapshot/extra", {
        headers: { cookie },
      });
      expect(suffix.status).toBe(404);

      const unknown = await rawRequest(app, "GET", "/observe/unknown", {
        headers: { cookie },
      });
      expect(unknown.status).toBe(404);
    } finally {
      await app.close();
      await upstream.close();
    }
  });

  it("query 指定上游 URL 一律拒绝，且不命中上游", async () => {
    let snapshotHits = 0;
    const upstream = await listenUpstream((_req, res) => {
      snapshotHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const app = makeApp(upstream.baseUrl);
    try {
      const cookie = await bootstrap(app);
      const res = await rawRequest(app, "GET", "/observe/snapshot?url=http://evil.example/snapshot", {
        headers: { cookie },
      });

      expect(res.status).toBe(403);
      expect(snapshotHits).toBe(0);
    } finally {
      await app.close();
      await upstream.close();
    }
  });

  it("上游 302 重定向不跟随，显式拒绝", async () => {
    const upstream = await listenUpstream((_req, res) => {
      res.writeHead(302, { location: "http://evil.example/redirected" });
      res.end();
    });
    const app = makeApp(upstream.baseUrl);
    try {
      const cookie = await bootstrap(app);
      const res = await rawRequest(app, "GET", "/observe/snapshot", {
        headers: { cookie },
      });

      expect(res.status).toBe(502);
      expect(res.body).not.toContain("evil.example");
    } finally {
      await app.close();
      await upstream.close();
    }
  });

  it("N30 凭据/端点不出现在代理响应体与页面 HTML", async () => {
    const upstream = await listenUpstream((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><html><body><h1>N30 standalone</h1></body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const app = makeApp(upstream.baseUrl);
    try {
      const cookie = await bootstrap(app);

      const page = await rawRequest(app, "GET", "/observe/", {
        headers: { cookie },
      });
      expect(page.status).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.body).toContain("N30 standalone");
      expect(page.body).not.toContain(upstream.baseUrl);

      const snap = await rawRequest(app, "GET", "/observe/snapshot", {
        headers: { cookie },
      });
      expect(snap.status).toBe(200);
      expect(snap.body).not.toContain(upstream.baseUrl);
      expect(snap.body).not.toContain("n30-secret");
    } finally {
      await app.close();
      await upstream.close();
    }
  });

  it("N30 down 时显式降级：/observe/snapshot 返回 502，前端壳含显式降级控件", async () => {
    const upstream = await listenUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const deadBaseUrl = upstream.baseUrl;
    await upstream.close();

    const app = makeApp(deadBaseUrl);
    try {
      const cookie = await bootstrap(app);
      const res = await rawRequest(app, "GET", "/observe/snapshot", {
        headers: { cookie },
      });

      expect(res.status).toBe(502);
      const body = JSON.parse(res.body) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("N30_UNAVAILABLE");
      expect(body.error.message).toContain("N30");

      const js = await rawRequest(app, "GET", "/app.js");
      expect(js.status).toBe(200);
      expect(js.body).toContain("overview-degraded");
      expect(js.body).toContain("N30 不可用");
      expect(js.body).toContain("overview-retry");
    } finally {
      await app.close();
    }
  });
});
