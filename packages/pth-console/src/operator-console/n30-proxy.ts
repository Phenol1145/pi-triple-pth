/**
 * operator-console/n30-proxy.ts — N30 只读同源代理（fail-closed）
 *
 * 安全边界：
 * - 只代理恰好三个同源路径：/observe/、/observe/snapshot、/observe/events；
 * - 只允许 GET；POST/Upgrade/未知路径/路径后缀/query 指定上游一律拒绝；
 * - 上游只来自服务端配置的 loopback N30_URL，绝不接受浏览器指定；
 * - 双向剥离 authorization/cookie/set-cookie/connection 与代理头；
 * - HTML/snapshot 有响应大小与时间限制；SSE 有客户端数、心跳超时和浏览器断开联动。
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

export const N30_READ_ONLY_PATHS = ["/observe/", "/observe/snapshot", "/observe/events"] as const;

export type N30ReadOnlyProxyPath = (typeof N30_READ_ONLY_PATHS)[number];

export interface N30ReadOnlyProxyOptions {
  /** 唯一上游；必须是 http://127.0.0.1 且无 path/query/hash（fail-closed）。 */
  readonly baseUrl: string;
  readonly clock?: () => number;
  readonly timeoutMs?: number;
  readonly maxHtmlBytes?: number;
  readonly maxSnapshotBytes?: number;
  readonly maxSseClients?: number;
  readonly sseHeartbeatTimeoutMs?: number;
}

export interface N30ReadOnlyProxy {
  readonly baseUrl: string;
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_HTML_BYTES = 512 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SSE_CLIENTS = 8;
const DEFAULT_SSE_HEARTBEAT_TIMEOUT_MS = 30_000;

/** 浏览器 query 里出现这些 key 视为试图指定上游/目标，直接拒绝。 */
const FORBIDDEN_QUERY_KEYS = new Set(["url", "target", "upstream", "baseurl", "n30url", "proxy"]);

const REQUEST_HEADER_BLOCK = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "via",
  "upgrade",
  "http2-settings",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "content-length",
  "host",
]);

const RESPONSE_HEADER_BLOCK = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "via",
  "www-authenticate",
  "content-length",
  "transfer-encoding",
]);

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function validateLoopbackBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("n30 proxy upstream must be an http://127.0.0.1 URL (loopback only)");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error(`n30 proxy upstream must be an http://127.0.0.1 URL (loopback only), got: ${raw}`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("n30 proxy upstream must be a root URL without path, query, or hash");
  }
  return url;
}

export function isN30ReadOnlyProxyPath(pathname: string): pathname is N30ReadOnlyProxyPath {
  return (N30_READ_ONLY_PATHS as readonly string[]).includes(pathname);
}

function upstreamPathFor(pathname: N30ReadOnlyProxyPath): string {
  if (pathname === "/observe/") return "/";
  if (pathname === "/observe/snapshot") return "/snapshot";
  return "/events";
}

function hasForbiddenQuery(pathname: string, req: IncomingMessage): boolean {
  const rawUrl = req.url ?? "";
  let url: URL;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return true;
  }
  for (const key of url.searchParams.keys()) {
    if (FORBIDDEN_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

function buildUpstreamHeaders(req: IncomingMessage, upstream: URL): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name === undefined || value === undefined) continue;
    if (REQUEST_HEADER_BLOCK.has(name)) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers.host = upstream.host;
  return headers;
}

function copySafeResponseHeaders(upstream: IncomingMessage, res: ServerResponse): void {
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (name === undefined || value === undefined) continue;
    if (RESPONSE_HEADER_BLOCK.has(name)) continue;
    res.setHeader(name, Array.isArray(value) ? value.join(", ") : value);
  }
}

export function createN30ReadOnlyProxy(options: N30ReadOnlyProxyOptions): N30ReadOnlyProxy {
  const upstream = validateLoopbackBaseUrl(options.baseUrl);
  const clock = options.clock ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const maxSseClients = options.maxSseClients ?? DEFAULT_MAX_SSE_CLIENTS;
  const sseHeartbeatTimeoutMs = options.sseHeartbeatTimeoutMs ?? DEFAULT_SSE_HEARTBEAT_TIMEOUT_MS;

  let sseClients = 0;
  const activeRequests = new Set<ReturnType<typeof httpRequest>>();

  function trackRequest(req: ReturnType<typeof httpRequest>): void {
    activeRequests.add(req);
    req.on("close", () => activeRequests.delete(req));
  }

  function rejectReadOnly(res: ServerResponse): void {
    sendJson(res, 403, {
      error: { code: "READ_ONLY_PROXY", message: "N30 observability proxy is read-only; only GET is allowed" },
    });
  }

  function rejectForbiddenQuery(res: ServerResponse): void {
    sendJson(res, 403, {
      error: { code: "FORBIDDEN_QUERY", message: "query-supplied upstream or target URLs are rejected" },
    });
  }

  function sendUpstreamFailure(res: ServerResponse, code: string, message: string): void {
    sendJson(res, 502, { error: { code, message } });
  }

  function rejectRedirect(res: ServerResponse, status: number): void {
    sendJson(res, 502, {
      error: { code: "BAD_UPSTREAM_REDIRECT", message: `N30 upstream redirect (HTTP ${status}) rejected` },
    });
  }

  async function proxyBounded(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: N30ReadOnlyProxyPath,
    maxBytes: number,
  ): Promise<void> {
    const queryIndex = (req.url ?? "").indexOf("?");
    const query = queryIndex >= 0 ? (req.url ?? "").slice(queryIndex) : "";
    const upstreamPath = `${upstreamPathFor(pathname)}${query}`;

    await new Promise<void>((resolve) => {
      let settled = false;
      const upstreamReq = httpRequest(
        {
          host: upstream.hostname,
          port: upstream.port || 80,
          path: upstreamPath,
          method: "GET",
          headers: buildUpstreamHeaders(req, upstream),
        },
        (upstreamRes) => {
          const status = upstreamRes.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            upstreamRes.resume();
            rejectRedirect(res, status);
            settled = true;
            resolve();
            return;
          }
          if (status !== 200) {
            upstreamRes.resume();
            sendUpstreamFailure(res, "N30_UNAVAILABLE", `N30 observability source returned HTTP ${status}`);
            settled = true;
            resolve();
            return;
          }

          copySafeResponseHeaders(upstreamRes, res);
          res.statusCode = 200;
          res.setHeader("content-length", "0");

          const chunks: Buffer[] = [];
          let size = 0;
          const startedAt = clock();

          upstreamRes.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              upstreamRes.destroy();
              if (!res.headersSent) {
                sendUpstreamFailure(res, "UPSTREAM_RESPONSE_TOO_LARGE", "N30 upstream response exceeded the configured size limit");
              } else {
                res.destroy();
              }
              settled = true;
              resolve();
              return;
            }
            chunks.push(chunk);
          });
          upstreamRes.on("end", () => {
            if (settled) return;
            settled = true;
            const body = Buffer.concat(chunks);
            res.setHeader("content-length", String(body.length));
            if (!res.headersSent) {
              res.writeHead(200, { ...res.getHeaders() });
            }
            res.end(body);
            resolve();
          });
          upstreamRes.on("error", () => {
            if (settled) return;
            settled = true;
            if (!res.headersSent) {
              sendUpstreamFailure(res, "N30_UNAVAILABLE", "N30 observability source is unavailable");
            } else {
              res.destroy();
            }
            resolve();
          });

          const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            upstreamReq.destroy();
            if (!res.headersSent) {
              sendJson(res, 504, {
                error: { code: "UPSTREAM_TIMEOUT", message: "N30 upstream did not respond in time" },
              });
            } else {
              res.destroy();
            }
            resolve();
          }, timeoutMs);
          res.on("close", () => {
            if (settled) {
              clearTimeout(timeout);
              return;
            }
            if (!res.writableEnded) {
              settled = true;
              clearTimeout(timeout);
              upstreamReq.destroy();
              resolve();
            }
          });
          void startedAt;
        },
      );

      upstreamReq.on("error", () => {
        if (settled) return;
        settled = true;
        sendUpstreamFailure(res, "N30_UNAVAILABLE", "N30 observability source is unavailable");
        resolve();
      });
      upstreamReq.on("timeout", () => {
        if (settled) return;
        settled = true;
        upstreamReq.destroy();
        sendJson(res, 504, {
          error: { code: "UPSTREAM_TIMEOUT", message: "N30 upstream did not respond in time" },
        });
        resolve();
      });
      trackRequest(upstreamReq);
      upstreamReq.end();
    });
  }

  function proxySse(req: IncomingMessage, res: ServerResponse): void {
    if (sseClients >= maxSseClients) {
      sendJson(res, 503, {
        error: { code: "SSE_CLIENT_LIMIT", message: `N30 SSE client limit reached (${maxSseClients})` },
      });
      return;
    }
    sseClients += 1;

    let settled = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      sseClients -= 1;
    };

    const upstreamReq = httpRequest(
      {
        host: upstream.hostname,
        port: upstream.port || 80,
        path: upstreamPathFor("/observe/events"),
        method: "GET",
        headers: buildUpstreamHeaders(req, upstream),
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          upstreamRes.resume();
          rejectRedirect(res, status);
          cleanup();
          settled = true;
          return;
        }
        if (status !== 200) {
          upstreamRes.resume();
          sendUpstreamFailure(res, "N30_UNAVAILABLE", `N30 observability source returned HTTP ${status}`);
          cleanup();
          settled = true;
          return;
        }

        res.writeHead(200, {
          "content-type": upstreamRes.headers["content-type"] ?? "text/event-stream",
          "cache-control": upstreamRes.headers["cache-control"] ?? "no-cache",
        });

        const armHeartbeatTimeout = (): void => {
          if (heartbeatTimer) clearTimeout(heartbeatTimer);
          heartbeatTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            upstreamRes.destroy();
            if (!res.writableEnded) {
              res.write('event: error\ndata: {"error":{"code":"UPSTREAM_SSE_TIMEOUT"}}\n\n');
              res.end();
            }
            cleanup();
          }, sseHeartbeatTimeoutMs);
        };
        armHeartbeatTimeout();

        upstreamRes.on("data", (chunk: Buffer) => {
          if (settled) return;
          armHeartbeatTimeout();
          if (!res.writableEnded) res.write(chunk);
        });
        upstreamRes.on("end", () => {
          if (settled) return;
          settled = true;
          cleanup();
          if (!res.writableEnded) res.end();
        });
        upstreamRes.on("error", () => {
          if (settled) return;
          settled = true;
          cleanup();
          if (!res.writableEnded) {
            res.write('event: error\ndata: {"error":{"code":"N30_UNAVAILABLE"}}\n\n');
            res.end();
          }
        });

        res.on("close", () => {
          if (settled) return;
          if (!res.writableEnded) {
            settled = true;
            upstreamRes.destroy();
            cleanup();
          }
        });
      },
    );

    upstreamReq.on("error", () => {
      if (settled) return;
      settled = true;
      cleanup();
      sendUpstreamFailure(res, "N30_UNAVAILABLE", "N30 observability source is unavailable");
    });
    trackRequest(upstreamReq);
    upstreamReq.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (!isN30ReadOnlyProxyPath(pathname)) {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown observe route" } });
      return;
    }
    if (req.method !== "GET") {
      rejectReadOnly(res);
      return;
    }
    if (hasForbiddenQuery(pathname, req)) {
      rejectForbiddenQuery(res);
      return;
    }
    if (pathname === "/observe/events") {
      proxySse(req, res);
      return;
    }
    const maxBytes = pathname === "/observe/" ? maxHtmlBytes : maxSnapshotBytes;
    await proxyBounded(req, res, pathname, maxBytes);
  }

  async function close(): Promise<void> {
    for (const req of [...activeRequests]) {
      req.destroy();
    }
    activeRequests.clear();
  }

  return { baseUrl: upstream.toString(), handle, close };
}
