#!/usr/bin/env node
/**
 * copy-runtime-assets.mjs —— 运行时数据资产拷贝（tsc 不搬非 TS 文件）。
 *
 * 背景（2026-08-25）：role-catalog-loader 以 import.meta.url 相对路径读
 * `catalog/data/roles/*.json`（42 张角色卡）。tsc 只产出 .js/.d.ts，
 * dist 运行（容器/pth:start）会因缺 JSON 在 bootstrap fail-closed。
 *
 * 规则：把 src/pth/catalog/data 下的所有 *.json 原样复制到 dist/pth/catalog/data，
 * 保持子目录结构；源目录缺失则 fail（构建期暴露，不留到运行时）。
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = join(root, "src", "pth", "catalog", "data", "roles");
const dst = join(root, "dist", "pth", "catalog", "data", "roles");

if (!existsSync(src)) {
  throw new Error(`copy-runtime-assets: 源目录不存在: ${src}`);
}
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true, filter: (s) => !s.endsWith(".ts") && !s.endsWith(".map") });
console.log(`runtime assets: ${src} → ${dst}`);
