/**
 * operator-console/server-assets.ts —— console server 的冻结静态资源加载。
 *
 * 生产/本地启动：读取 Vite 构建产出的 `asset-manifest.json`，只预载清单内文件并校验 sha256；
 * vitest（NODE_ENV=test）或无 manifest 时回退 legacy 六文件源码目录，保持 v1.3 测试面稳定。
 * 缺失任一必需资源即抛错（fail-closed）。
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

function loadLegacyAssets(sourceDir: string): Map<string, OperatorConsoleAsset> {
  const assets = new Map<string, OperatorConsoleAsset>();
  for (const filename of KNOWN_ASSETS) {
    const fullPath = path.join(sourceDir, filename);
    if (!existsSync(fullPath)) {
      throw new Error(`operator console asset missing: ${fullPath}`);
    }
    assets.set(filename, {
      buffer: readFileSync(fullPath),
      mime: ASSET_MIME[filename]!,
    });
  }
  return assets;
}

export function loadOperatorConsoleAssets(): Map<string, OperatorConsoleAsset> {
  // 编译产物：dist/operator-console/public；源码 tsx/vitest：web/operator-console
  const compiled = fileURLToPath(new URL("./public/", import.meta.url));
  const source = fileURLToPath(new URL("../../web/operator-console/", import.meta.url));
  const manifestPath = path.join(compiled, "asset-manifest.json");
  if (existsSync(manifestPath) && process.env.NODE_ENV !== "test") {
    return loadManifestAssets(compiled);
  }
  return loadLegacyAssets(source);
}

export { ASSET_MIME, KNOWN_ASSETS };
