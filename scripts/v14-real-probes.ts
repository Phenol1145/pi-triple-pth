/**
 * scripts/v14-real-probes.ts —— v1.4 权威评测器的真实公共探针。
 *
 * 前置：`npm run build:web -w @away_from/pth-console` 已完成（eval 只消费 manifest）。
 * 输出只含计数/布尔，不含动态端口、时间戳或 requestId → 同一 commit 双跑字节一致。
 */

import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createOperatorConsoleServer, type OperatorConsoleServer } from "../packages/framework/dist/operator-console/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = `${root}/packages/framework/dist/operator-console/public`;
const manifestPath = `${publicDir}/asset-manifest.json`;
const BOOTSTRAP_TOKEN = "a".repeat(64);

interface RawResponse { status: number; body: string; headers: http.IncomingHttpHeaders }

function httpRequest(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function bootstrap(app: OperatorConsoleServer): Promise<string> {
  await app.listen();
  const body = JSON.stringify({ token: BOOTSTRAP_TOKEN });
  const res = await httpRequest(app.port, "POST", "/api/session/bootstrap", {
    origin: app.origin,
    host: app.hostHeader,
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  }, body);
  if (res.status !== 200) throw new Error(`bootstrap failed: ${res.status}`);
  return (res.headers["set-cookie"] ?? "").toString().split(";")[0] ?? "";
}

function probeManifest(): { files: number; digestsOk: number; hasEntry: boolean; hasCss: boolean; hasIndexJs: boolean } {
  if (!existsSync(manifestPath)) return { files: 0, digestsOk: 0, hasEntry: false, hasCss: false, hasIndexJs: false };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, { path: string; sha256: string }>;
  let digestsOk = 0;
  for (const [rel, entry] of Object.entries(manifest)) {
    const buffer = readFileSync(`${publicDir}/${rel}`);
    if (createHash("sha256").update(buffer).digest("hex") === entry.sha256) digestsOk += 1;
  }
  return {
    files: Object.keys(manifest).length,
    digestsOk,
    hasEntry: Boolean(manifest["index.html"]),
    hasCss: Boolean(manifest["assets/index.css"]),
    hasIndexJs: Boolean(manifest["assets/index.js"]),
  };
}

async function probeModuleGraph(): Promise<{ servedAssets: number; expectedAssets: number }> {
  const manifest = probeManifest();
  const expectedAssets = manifest.files;
  const app = createOperatorConsoleServer({
    host: "127.0.0.1",
    bootstrapToken: BOOTSTRAP_TOKEN,
    operatorPrincipalId: "eval-v14",
    pth: {},
    n30: {},
  });
  try {
    await app.listen();
    let servedAssets = 0;
    for (const rel of Object.keys(JSON.parse(readFileSync(manifestPath, "utf8")))) {
      const res = await httpRequest(app.port, "GET", `/${rel}`);
      if (res.status === 200) servedAssets += 1;
    }
    return { servedAssets, expectedAssets };
  } finally {
    await app.close();
  }
}

async function probeSecretBoundary(): Promise<{ upstreamErrors: number; requestIds: number; leakedSentinelCount: number }> {
  const sentinel = "v14-secret-sentinel|postgres://user:secret@db|http://user:secret@host";
  const upstream = http.createServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: sentinel }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const app = createOperatorConsoleServer({
    host: "127.0.0.1",
    bootstrapToken: BOOTSTRAP_TOKEN,
    operatorPrincipalId: "eval-v14",
    pth: { baseUrl: `http://127.0.0.1:${port}`, token: "eval-held-token" },
    n30: {},
  });
  try {
    const cookie = await bootstrap(app);
    let upstreamErrors = 0;
    let requestIds = 0;
    let leakedSentinelCount = 0;
    for (const path of ["/api/config/pth", "/api/memory/entries", "/api/debug/workers"]) {
      const res = await httpRequest(app.port, "GET", path, { cookie });
      if (res.status === 502) upstreamErrors += 1;
      const parsed = JSON.parse(res.body) as { error?: { requestId?: string } };
      if (typeof parsed.error?.requestId === "string" && parsed.error.requestId.length >= 8) requestIds += 1;
      leakedSentinelCount += sentinel.split("|").filter((part) => res.body.includes(part)).length;
    }
    return { upstreamErrors, requestIds, leakedSentinelCount };
  } finally {
    await app.close();
    await closeServer(upstream);
  }
}

export async function runV14RealProbes(): Promise<{
  manifest: ReturnType<typeof probeManifest>;
  moduleGraph: { servedAssets: number; expectedAssets: number };
  secretBoundary: { upstreamErrors: number; requestIds: number; leakedSentinelCount: number };
}> {
  const manifest = probeManifest();
  const moduleGraph = await probeModuleGraph();
  const secretBoundary = await probeSecretBoundary();
  return { manifest, moduleGraph, secretBoundary };
}
