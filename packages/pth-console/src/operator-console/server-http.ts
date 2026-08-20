/**
 * operator-console/server-http.ts —— console server 的纯 HTTP 原语。
 *
 * 从 server.ts 拆出以控制文件体量；无业务依赖，可独立单测。
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const ASSET_MIME: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "debug.js": "text/javascript; charset=utf-8",
  "memory.js": "text/javascript; charset=utf-8",
  "config.js": "text/javascript; charset=utf-8",
};
export const KNOWN_ASSETS = new Set(Object.keys(ASSET_MIME));
export const MAX_JSON_BODY_BYTES = 16 * 1024;

export function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function sendText(res: ServerResponse, status: number, body: string, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function sendEmpty(res: ServerResponse, status: number, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "cache-control": "no-store", ...extraHeaders });
  res.end();
}

/**
 * 上游失败只回传稳定 code + 可关联 requestId。上游正文/错误字符串可能含
 * token、DB URL、内部诊断或专业软件凭据，一律不进浏览器响应。
 */
export function sendUpstreamFailure(res: ServerResponse, code: string): void {
  sendJson(res, 502, {
    error: {
      code,
      message: "upstream PTH request failed; the raw response is never forwarded to the browser",
      requestId: randomUUID(),
    },
  });
}

export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
