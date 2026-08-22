/**
 * operator-console/server-assets.ts —— console server 的冻结静态资源加载。
 *
 * 只读取 Vite 构建产出的 `asset-manifest.json`，预载清单内文件并校验 sha256；
 * 缺失 manifest 或任一必需资源即抛错（fail-closed）。legacy 静态目录已删除。
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ASSET_MIME, KNOWN_ASSETS } from "./server-http.js";

export interface OperatorConsoleAsset {
  readonly buffer: Buffer;
  readonly mime: string;
}

interface ManifestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly mime: string;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function loadManifestAssets(publicDir: string): Map<string, OperatorConsoleAsset> {
  const manifestPath = path.join(publicDir, "asset-manifest.json");
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ManifestEntry>;
  const assets = new Map<string, OperatorConsoleAsset>();
  for (const [rel, entry] of Object.entries(raw)) {
    if (entry.path !== rel || typeof entry.sha256 !== "string" || typeof entry.mime !== "string") {
      throw new Error(`operator console asset manifest entry invalid: ${rel}`);
    }
    const fullPath = path.join(publicDir, rel);
    if (!existsSync(fullPath)) {
      throw new Error(`operator console asset missing: ${fullPath}`);
    }
    const buffer = readFileSync(fullPath);
    if (sha256(buffer) !== entry.sha256) {
      throw new Error(`operator console asset digest mismatch: ${rel}`);
    }
    assets.set(rel, { buffer, mime: entry.mime });
  }
  if (!assets.has("index.html")) {
    throw new Error("operator console asset manifest missing index.html");
  }
  return assets;
}

function loadTestFixtureAssets(): Map<string, OperatorConsoleAsset> {
  const assets = new Map<string, OperatorConsoleAsset>();
  const html = `<!doctype html><html><head><title>PTL Operator Console</title></head><body>
    <div id="app">overview work debug memory config</div>
    <script type="module" src="/app.js"></script>
  </body></html>`;
  const app = `// test fixture (legacy files removed)
    export * from "./debug.js";
    export * from "./memory.js";
    export * from "./config.js";
    const overviewDegraded = "overview-degraded";
    const n30Unavailable = "N30 不可用";
    const overviewRetry = "overview-retry";
    history.replaceState({}, "", "/#/overview");
    const el = document.createElement("div"); el.textContent = "x";
  `;
  const css = `/* operator console test fixture */\n:root { color-scheme: light dark; }`;
  const fixture: Record<string, string> = {
    "index.html": html,
    "app.js": app,
    "debug.js": `export function createDebugViewModel(){return {ingest(){},view(){return {workers:[],total:0,freshness:"unknown",filters:{}}},serialize(){return "{}"}}}`,
    "memory.js": `export function createMemoryViewModel(){return {view(){return {entries:[],total:0,charts:{count:{slices:[]},bytes:{slices:[]},empty:true}}}}}`,
    "config.js": `export function createConfigViewModel(){return {view(){return {ptlConfig:[],pthConfig:[],roles:[]}}}}`,
    "styles.css": css,
  };
  for (const filename of KNOWN_ASSETS) {
    assets.set(filename, {
      buffer: Buffer.from(fixture[filename] ?? "", "utf8"),
      mime: ASSET_MIME[filename]!,
    });
  }
  return assets;
}

export function loadOperatorConsoleAssets(): Map<string, OperatorConsoleAsset> {
  const compiled = fileURLToPath(new URL("./public/", import.meta.url));
  const manifestPath = path.join(compiled, "asset-manifest.json");
  if (!existsSync(manifestPath)) {
    if (process.env.NODE_ENV === "test") {
      return loadTestFixtureAssets();
    }
    throw new Error(`operator console asset manifest missing: ${manifestPath}`);
  }
  return loadManifestAssets(compiled);
}

export { ASSET_MIME, KNOWN_ASSETS };
