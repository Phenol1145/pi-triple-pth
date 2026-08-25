#!/usr/bin/env tsx
/**
 * check-pth-boundaries.ts — PTH 模块化 v2 P0-2 的 import 边界检查 CLI。
 *
 * 用法：
 *   npm run check:pth-boundaries            # 与基线比较；新增违规 → 非零退出
 *   npm run check:pth-boundaries -- --update  # 用当前违规清单刷新基线（阶段收账用）
 *
 * 基线语义：当前违规清单必须 ⊆ 基线（即不允许出现未入账的新违规）；
 * 已被修复的违规允许不再出现——阶段收账时用 --update 收紧基线。
 */

import path from "node:path";
import { writeFile } from "node:fs/promises";
import {
  baselineKey,
  collectBoundaryViolations,
  loadBoundaryBaseline,
  type BoundaryViolation,
} from "./pth-boundaries-core.js";

const repoRoot = process.cwd();
const srcRoot = path.join(repoRoot, "src", "pth");
const baselineFile = path.join(repoRoot, "scripts", "check", "pth-boundaries.baseline.json");
const update = process.argv.includes("--update");

const current = await collectBoundaryViolations(srcRoot);
console.log(`── pth-boundaries：当前违规 ${current.length} 条 ──`);
for (const v of current) {
  console.log(`${v.rule}  ${v.file}:${v.line}  ${v.detail}`);
}

if (update) {
  const payload: BoundaryViolation[] = current;
  await writeFile(baselineFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`baseline written: ${baselineFile} (${payload.length})`);
  process.exit(0);
}

const baseline = await loadBoundaryBaseline(baselineFile);
const baselineKeys = new Set(baseline.map(baselineKey));
const currentKeys = new Set(current.map(baselineKey));
const added = current.filter((v) => !baselineKeys.has(baselineKey(v)));
const removed = baseline.filter((v) => !currentKeys.has(baselineKey(v)));

if (removed.length > 0) {
  console.log(`── 已修复（可从基线移除）${removed.length} 条 ──`);
  for (const v of removed) console.log(`${v.rule}  ${v.file}:${v.line}  ${v.detail}`);
}
if (added.length > 0) {
  console.log(`── 新增违规 ${added.length} 条（必须修复或先入账）──`);
  process.exit(1);
}
console.log("✅ 无新增边界违规");
