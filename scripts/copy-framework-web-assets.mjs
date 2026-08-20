#!/usr/bin/env node
/**
 * copy-framework-web-assets.mjs — 将 framework 的 operator-console Web 壳
 * 确定性地复制到 dist/operator-console/public。
 *
 * 约束：只允许 index.html / styles.css / app.js + debug.js / memory.js / config.js；拒绝符号链接与未知扩展名；
 * 复制前只删除该目标目录，不触碰其他产物。
 */

import { mkdirSync, readdirSync, rmSync, copyFileSync, lstatSync, existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "packages", "framework", "web", "operator-console");
const destDir = join(root, "packages", "framework", "dist", "operator-console", "public");

// v1.3 N33：T6/T7/T8 新增的纯页面模块与壳三件套同等对待（仍拒绝一切未知扩展名/符号链接）。
const ALLOWED_FILES = new Set(["index.html", "styles.css", "app.js", "debug.js", "memory.js", "config.js"]);
const ALLOWED_EXTENSIONS = new Set([".html", ".css", ".js"]);

function copyRecursive(from, to) {
  if (!existsSync(from)) {
    throw new Error(`operator-console web source missing: ${from}`);
  }
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) {
    throw new Error(`operator-console web assets must not contain symlinks: ${from}`);
  }
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      copyRecursive(join(from, entry), join(to, entry));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`operator-console web asset is not a regular file: ${from}`);
  }
  const name = from.split("/").pop();
  if (!ALLOWED_FILES.has(name)) {
    throw new Error(`operator-console web asset not allowed: ${from}`);
  }
  const ext = extname(from);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`operator-console web asset has unknown extension: ${from}`);
  }
  copyFileSync(from, to);
}

rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });
copyRecursive(sourceDir, destDir);

const copied = readdirSync(destDir).sort();
if (copied.length !== ALLOWED_FILES.size || copied.some((f) => !ALLOWED_FILES.has(f))) {
  throw new Error(`operator-console public directory must contain exactly the allowed assets; got: ${copied.join(", ")}`);
}

console.log(`operator-console public assets copied: ${copied.join(", ")}`);
