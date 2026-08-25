#!/usr/bin/env node
/**
 * copy-framework-web-assets.mjs —— v1.4：Vite 构建产物校验（不再复制 legacy 文件）。
 *
 * `npm run build:web` 已把 Preact 应用写入 packages/pth-console/dist/operator-console/public，
 * 并生成 asset-manifest.json。本脚本只做发行级校验：
 *  - manifest 是唯一允许服务清单，必须包含 index.html；
 *  - 每个清单文件必须存在、扩展名在白名单内、sha256 与磁盘一致；
 *  - public 目录内除了清单文件外不得出现未列入清单的文件（fail-closed）。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "packages", "pth-console", "dist", "operator-console", "public");
const manifestPath = join(publicDir, "asset-manifest.json");
const ALLOWED_EXTENSIONS = new Set([".html", ".css", ".js", ".svg", ".ico", ".png", ".webp", ".woff", ".woff2"]);

function fail(message) {
  throw new Error(`pth-console web asset validation failed: ${message}`);
}

if (!existsSync(manifestPath)) fail("asset-manifest.json missing");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!manifest || typeof manifest !== "object" || !manifest["index.html"]) fail("manifest must contain index.html");

const listed = new Set(Object.keys(manifest));
for (const [rel, entry] of Object.entries(manifest)) {
  if (!entry || entry.path !== rel || typeof entry.sha256 !== "string" || typeof entry.mime !== "string") {
    fail(`manifest entry invalid: ${rel}`);
  }
  const ext = extname(rel);
  if (!ALLOWED_EXTENSIONS.has(ext)) fail(`manifest extension not allowed: ${rel}`);
  const full = join(publicDir, rel);
  if (!existsSync(full)) fail(`manifest file missing: ${rel}`);
  const buffer = readFileSync(full);
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (digest !== entry.sha256) fail(`digest mismatch: ${rel}`);
}

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(relative(publicDir, full));
  }
  return out;
}
for (const rel of listFiles(publicDir)) {
  if (rel === "asset-manifest.json") continue;
  if (!listed.has(rel)) fail(`file not listed in manifest: ${rel}`);
}

console.log(`pth-console public assets validated: ${listed.size} files (${[...listed].sort().join(", ")})`);
