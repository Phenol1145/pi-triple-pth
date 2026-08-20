/**
 * console-api-contract.test.ts —— Console OpenAPI 契约合规（防协议漂移）。
 *
 * 把 packages/framework/operator-console-openapi.json 当作唯一机器可读路由清单：
 *  - 每个 spec path 在真实 loopback server 上必须存在（绝不 404）；
 *  - 错误响应必须满足统一 error envelope；
 *  - /api/version 与 v1 前缀行为冻结；
 *  - PTH console-facing spec 存在且为合法 OpenAPI 形状。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createOperatorConsoleServer, type OperatorConsoleServer } from "../../packages/framework/src/operator-console/index.js";

const BOOTSTRAP_TOKEN = "c".repeat(64);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, { operationId?: string }>>;
}

const consoleSpec = JSON.parse(
  readFileSync(`${repoRoot}/packages/framework/operator-console-openapi.json`, "utf8"),
) as OpenApiDoc;
const pthSpec = JSON.parse(
  readFileSync(`${repoRoot}/docs/pth/pth-console-openapi.json`, "utf8"),
) as OpenApiDoc;

interface RawResponse { status: number; body: string }

function request(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("console API contract", () => {
  let app: OperatorConsoleServer;

  beforeAll(async () => {
    app = createOperatorConsoleServer({
      host: "127.0.0.1",
      bootstrapToken: BOOTSTRAP_TOKEN,
      operatorPrincipalId: "contract-test",
      pth: { baseUrl: "http://127.0.0.1:9", token: "contract-held-token" },
      n30: {},
    });
    await app.listen();
  });

  afterAll(async () => {
    await app.close();
  });

  it("OpenAPI 形状合法且所有 console path 都带 /api/v1 前缀", () => {
    expect(consoleSpec.openapi).toMatch(/^3\./);
    expect(consoleSpec.info.title).toContain("Operator Console");
    expect(Object.keys(consoleSpec.paths).length).toBeGreaterThan(10);
    for (const path of Object.keys(consoleSpec.paths)) {
      expect(path, path).toMatch(/^\/api\/v1\//);
    }
    const ids = Object.values(consoleSpec.paths).flatMap((methods) =>
      Object.values(methods).map((method) => method.operationId).filter(Boolean),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("spec 中的每个方法在真实 server 上都存在（非 404）", async () => {
    for (const [path, methods] of Object.entries(consoleSpec.paths)) {
      for (const method of Object.keys(methods)) {
        const httpMethod = method.toUpperCase();
        if (path === "/api/v1/version") continue;
        const response = await request(app.port, httpMethod, path);
        expect(response.status, `${httpMethod} ${path}`).not.toBe(404);
        if (response.body && response.status >= 400 && response.status < 600) {
          const parsed = JSON.parse(response.body) as { error?: { code?: string; message?: string } };
          expect(parsed.error?.code, `${httpMethod} ${path}`).toMatch(/^[A-Z][A-Z0-9_-]{0,63}$/);
          expect(parsed.error?.message).toBeTruthy();
        }
      }
    }
  });

  it("/api/v1/version 与 legacy /api/version 返回同一冻结形状", async () => {
    for (const path of ["/api/v1/version", "/api/version"]) {
      const response = await request(app.port, "GET", path);
      expect(response.status, path).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ api: "v1", service: "ptl-operator-console", version: "1.4.0" });
    }
  });

  it("legacy /api/session 被过渡重写到 v1（不再 404）", async () => {
    const response = await request(app.port, "GET", "/api/session");
    expect(response.status).toBe(401);
    const parsed = JSON.parse(response.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("UNAUTHORIZED");
  });

  it("PTH console-facing OpenAPI 存在且路径均为 /api/v1", () => {
    expect(pthSpec.openapi).toMatch(/^3\./);
    expect(pthSpec.info.title).toContain("PTH API");
    const paths = Object.keys(pthSpec.paths);
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) expect(path, path).toMatch(/^\/api\/v1\//);
  });
});
