/**
 * check-pth-config.ts —— 配置集中化防回潮检查（C2，2026-08-16）。
 *
 * 规则：
 *   1. src/pth 内 config/ 目录之外不得出现 process.env.PTH_* 直读（统一走 pthConfig/config）；
 *   2. schema 键必须唯一、type/default 合法；
 *   3. 报告 schema 键在 deploy compose 中的声明覆盖率（信息项——不 fail，由 ops 决定补齐）。
 *
 * 用法：npm run check:pth-config [--report]  /  `--report` 打印覆盖度明细。
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PTH_CONFIG_SCHEMA, getConfigDef } from "../src/pth/config/schema.js";

const SRC_ROOT = path.resolve("src/pth");
const COMPOSE_FILES = ["deploy/docker-compose.yaml", "deploy/pth.deployment.json"];

interface Issue {
  level: "error" | "info";
  message: string;
}

async function walk(dir: string, onFile: (rel: string, content: string) => void): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, onFile);
    else if (e.isFile() && e.name.endsWith(".ts")) {
      onFile(path.relative(SRC_ROOT, abs).split(path.sep).join("/"), await readFile(abs, "utf8"));
    }
  }
}

async function main(): Promise<void> {
  const issues: Issue[] = [];

  // 1. 直读防回潮（config/ 内部允许——loader 自身）
  await walk(SRC_ROOT, (rel, source) => {
    if (rel.startsWith("config/")) return;
    const m = /process\.env\.PTH_[A-Z0-9_]+/g.exec(source);
    if (m) {
      issues.push({ level: "error", message: `${rel}: 禁止直读 ${m[0]}——统一走 src/pth/config（pthConfig/config()）` });
    }
  });

  // 2. schema 完整性
  const seen = new Set<string>();
  for (const def of PTH_CONFIG_SCHEMA) {
    if (seen.has(def.key)) issues.push({ level: "error", message: `schema: 键重复 ${def.key}` });
    seen.add(def.key);
    if (!def.description?.trim()) issues.push({ level: "error", message: `schema: ${def.key} 缺 description` });
    if (def.default === null && def.type !== "json") issues.push({ level: "error", message: `schema: ${def.key} default 不得为 null` });
  }

  // 3. compose 覆盖度报告
  const composeText = (await Promise.all(COMPOSE_FILES.map((f) => readFile(f, "utf8").catch(() => "")))).join("\n");
  const undeclared: string[] = [];
  for (const def of PTH_CONFIG_SCHEMA) {
    if (def.scope === "cli") continue;   // CLI 键由客户端管，不进 compose
    if (!composeText.includes(def.key)) undeclared.push(def.key);
  }

  const errors = issues.filter((i) => i.level === "error");
  if (errors.length > 0) {
    for (const e of errors) console.error(`  ❌ ${e.message}`);
    console.error(`── pth-config：${errors.length} 条违规 ──`);
    process.exit(1);
  }
  console.log(`── pth-config：schema ${PTH_CONFIG_SCHEMA.length} 键 · 直读 0 · compose 未声明 ${undeclared.length} 键 ──`);
  if (process.argv.includes("--report")) {
    for (const k of undeclared) {
      const def = getConfigDef(k)!;
      console.log(`  - ${k.padEnd(38)} ${def.group.padEnd(12)} ${def.description}`);
    }
  }
  console.log("✅ pth-config 检查通过");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
