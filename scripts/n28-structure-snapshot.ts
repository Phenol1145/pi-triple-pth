#!/usr/bin/env tsx
/**
 * n28-structure-snapshot.ts —— N28 项目结构快照工具（结构漂移可机械比对）。
 *
 * 用途：
 *   - 默认（无参数）：把当前快照 JSON 打到 stdout（确定性排序，无时间戳/随机量/commit SHA）。
 *   - --update：写入基线 `docs/pth/n28-structure-baseline.json` 与结构报告
 *     `docs/pth/n28-structure-baseline.md`。
 *   - --check：与已提交基线逐文件/逐边比对；任何漂移（新增/删除/哈希/行数/根布局/导入边变化）
 *     打印差异并 exit 1，供合并者对照 lane 契约 §3 文件域逐条复核。确认预期后由合并者
 *     `--update` 在 merge 后的单独 docs commit 里刷新基线（审计链：基线更新与实现 merge 分离）。
 *
 * 扫描范围：
 *   - src/pth/**（.ts，含模块级 import 边）
 *   - test/**（.ts）
 *   - scripts/**（.ts）
 *   - packages/**（.ts + package.json；跳过 node_modules/dist）
 *   - 根布局：一级目录（排除 node_modules/dist/.git/.worktrees/coverage 及点开头目录）+ 根配置
 *     （package.json、tsconfig*.json、vitest.config.ts）
 *
 * 用法：
 *   npx tsx scripts/n28-structure-snapshot.ts
 *   npx tsx scripts/n28-structure-snapshot.ts --check
 *   npx tsx scripts/n28-structure-snapshot.ts --update
 */

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveImportTarget } from "./pth-boundaries-core.js";

const repoRoot = process.cwd();
const baselineJsonPath = path.join(repoRoot, "docs", "pth", "n28-structure-baseline.json");
const baselineMdPath = path.join(repoRoot, "docs", "pth", "n28-structure-baseline.md");

const SCHEMA_VERSION = 1 as const;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".worktrees", "coverage"]);
const posix = (p: string): string => p.split(path.sep).join("/");

interface FileHash {
  sha256: string;
  lines: number;
}

interface ImportEdge {
  from: string;
  kind: "type" | "runtime";
  specifier: string;
  target: string | null;
}

interface PackageMeta {
  path: string;
  name: string;
  version: string;
}

interface StructureSnapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  rootDirs: string[];
  rootConfigs: Record<string, FileHash>;
  srcPth: Record<string, FileHash>;
  tests: Record<string, FileHash>;
  scripts: Record<string, FileHash>;
  packages: Record<string, FileHash>;
  imports: ImportEdge[];
  packagesMeta: PackageMeta[];
  summary: {
    srcPthFiles: number;
    testFiles: number;
    scriptFiles: number;
    packageFiles: number;
    totalFiles: number;
    totalLines: number;
    importEdges: number;
    runtimeEdges: number;
    typeEdges: number;
    packageSpecifierEdges: number;
  };
}

function sha256Of(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function countLines(content: string): number {
  return content.split("\n").length;
}

async function walkFiles(
  absDir: string,
  predicate: (relPosixPath: string, basename: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const abs = path.join(dir, entry.name);
        const rel = posix(path.relative(repoRoot, abs));
        if (predicate(rel, entry.name)) out.push(rel);
      }
    }
  }
  await walk(absDir);
  return out.sort();
}

async function hashFiles(files: readonly string[]): Promise<Record<string, FileHash>> {
  const out: Record<string, FileHash> = {};
  for (const rel of files) {
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    out[rel] = { sha256: sha256Of(content), lines: countLines(content) };
  }
  return out;
}

/** 去掉行注释与块注释，避免注释里的示例代码被误判成模块边。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

interface ScannedModuleImport {
  kind: "type" | "runtime";
  specifier: string;
}

/**
 * 只认真实模块边：`import ... from "..."`、`export ... from "..."`、side-effect
 * `import "..."` 与 `import("...")`。与 pth-boundaries-core 的宽正则不同，本函数
 * 不把 `export type X = "..."` 或注释/模板串内容误判为导入边。
 */
function scanModuleImports(source: string): ScannedModuleImport[] {
  const stripped = stripComments(source);
  const out: ScannedModuleImport[] = [];
  const seen = new Set<string>();

  const staticRe = /(?:import|export)\s+([^;]*?)\s+from\s*['"]([^'"]+)['"]/g;
  for (let m = staticRe.exec(stripped); m; m = staticRe.exec(stripped)) {
    const kind = /\btype\b/.test(m[1] ?? "") ? "type" : "runtime";
    const key = `${kind}\u0000${m[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind, specifier: m[2] });
    }
  }

  const sideEffectRe = /^\s*import\s+['"]([^'"]+)['"]/gm;
  for (let m = sideEffectRe.exec(stripped); m; m = sideEffectRe.exec(stripped)) {
    const key = `runtime\u0000${m[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind: "runtime", specifier: m[1] });
    }
  }

  const dynamicRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m = dynamicRe.exec(stripped); m; m = dynamicRe.exec(stripped)) {
    // 与 pth-boundaries-core 同口径：dynamic import 按 type 记录（不据此判运行时适配器）。
    const key = `type\u0000${m[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind: "type", specifier: m[1] });
    }
  }

  return out;
}

async function collectImports(srcFiles: readonly string[]): Promise<ImportEdge[]> {
  const out: ImportEdge[] = [];
  for (const from of srcFiles) {
    const source = await readFile(path.join(repoRoot, from), "utf8");
    for (const imp of scanModuleImports(source)) {
      const target = imp.specifier.startsWith(".")
        ? resolveImportTarget(from, imp.specifier)
        : null;
      out.push({ from, kind: imp.kind, specifier: imp.specifier, target });
    }
  }
  return out.sort((a, b) =>
    (a.from.localeCompare(b.from)) ||
    (a.kind.localeCompare(b.kind)) ||
    (a.specifier.localeCompare(b.specifier)) ||
    (a.target ?? "").localeCompare(b.target ?? ""),
  );
}

async function readJsonOrUndefined(file: string): Promise<{ name: string; version: string } | undefined> {
  try {
    const content = await readFile(file, "utf8");
    const parsed = JSON.parse(content) as { name?: unknown; version?: unknown };
    if (typeof parsed.name === "string" && typeof parsed.version === "string") {
      return { name: parsed.name, version: parsed.version };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function buildSnapshot(): Promise<StructureSnapshot> {
  const rootEntries = await readdir(repoRoot, { withFileTypes: true });
  const rootDirs = rootEntries
    .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();

  const rootConfigRelPaths = (await readdir(repoRoot, { withFileTypes: true }))
    .filter((entry) =>
      entry.isFile() &&
      (entry.name === "package.json" ||
        entry.name.startsWith("tsconfig") ||
        entry.name === "vitest.config.ts"))
    .map((entry) => entry.name)
    .sort();
  const rootConfigs = await hashFiles(rootConfigRelPaths);

  const srcFiles = await walkFiles(path.join(repoRoot, "src", "pth"), (rel) => rel.endsWith(".ts"));
  const testFiles = await walkFiles(path.join(repoRoot, "test"), (rel) => rel.endsWith(".ts"));
  const scriptFiles = await walkFiles(path.join(repoRoot, "scripts"), (rel) => rel.endsWith(".ts"));
  const packageFiles = await walkFiles(
    path.join(repoRoot, "packages"),
    (rel, basename) => basename.endsWith(".ts") || basename === "package.json",
  );

  const [srcPth, tests, scripts, packages] = await Promise.all([
    hashFiles(srcFiles),
    hashFiles(testFiles),
    hashFiles(scriptFiles),
    hashFiles(packageFiles),
  ]);

  const imports = await collectImports(srcFiles);

  const packageJsonRelPaths = ["package.json", ...packageFiles.filter((rel) => rel.endsWith("package.json"))];
  const packagesMeta: PackageMeta[] = [];
  for (const rel of packageJsonRelPaths.sort()) {
    const meta = await readJsonOrUndefined(path.join(repoRoot, rel));
    if (meta) packagesMeta.push({ path: rel, ...meta });
  }

  const all = [...srcFiles, ...testFiles, ...scriptFiles, ...packageFiles];
  const fileRecords = { ...srcPth, ...tests, ...scripts, ...packages };
  const totalLines = all.reduce((sum, rel) => sum + (fileRecords[rel]?.lines ?? 0), 0);
  const packageSpecifierEdges = imports.filter((edge) => edge.target === null).length;

  const snapshot: StructureSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    rootDirs,
    rootConfigs,
    srcPth,
    tests,
    scripts,
    packages,
    imports,
    packagesMeta,
    summary: {
      srcPthFiles: srcFiles.length,
      testFiles: testFiles.length,
      scriptFiles: scriptFiles.length,
      packageFiles: packageFiles.length,
      totalFiles: all.length,
      totalLines,
      importEdges: imports.length,
      runtimeEdges: imports.filter((edge) => edge.kind === "runtime").length,
      typeEdges: imports.filter((edge) => edge.kind === "type").length,
      packageSpecifierEdges,
    },
  };
  return snapshot;
}

function summarizeLayerCounts(files: Record<string, FileHash>): Array<{ layer: string; files: number }> {
  const counts = new Map<string, number>();
  for (const rel of Object.keys(files)) {
    const layer = rel.startsWith("src/pth/")
      ? (rel.slice("src/pth/".length).split("/")[0] ?? "")
      : rel;
    counts.set(layer, (counts.get(layer) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([layer, files]) => ({ layer, files }));
}

function buildMarkdown(snapshot: StructureSnapshot): string {
  const layers = summarizeLayerCounts(snapshot.srcPth);
  const layerRows = layers.map(({ layer, files }) => `| ${layer}${layer.endsWith(".ts") ? "" : "/"} | ${files} |`).join("\n");
  const pkgRows = snapshot.packagesMeta
    .map((meta) => `| ${meta.path} | ${meta.name} | ${meta.version} |`)
    .join("\n");
  return `# N28 项目结构基线

> 由 \`scripts/n28-structure-snapshot.ts --update\` 生成；JSON 事实源：
> \`docs/pth/n28-structure-baseline.json\`。
> 每次 lane 合并回 main 后，合并者先 \`--check\` 对照 lane 契约 §3 文件域复核漂移，
> 再以单独 docs commit \`--update\` 刷新本基线。

## 摘要

| 项 | 值 |
|---|---|
| src/pth 文件 | ${snapshot.summary.srcPthFiles} |
| test 文件 | ${snapshot.summary.testFiles} |
| scripts 文件 | ${snapshot.summary.scriptFiles} |
| packages 文件（.ts + package.json） | ${snapshot.summary.packageFiles} |
| 合计 | ${snapshot.summary.totalFiles}（${snapshot.summary.totalLines} 行） |
| src/pth 导入边 | ${snapshot.summary.importEdges}（runtime ${snapshot.summary.runtimeEdges} / type ${snapshot.summary.typeEdges} / 包 specifier ${snapshot.summary.packageSpecifierEdges}） |
| 根一级目录 | ${snapshot.rootDirs.join("、")} |

## src/pth 分层

| 层 | 文件数 |
|---|---|
${layerRows}

## 包清单

| 位置 | name | version |
|---|---|---|
${pkgRows}
`;
}

function diffKeys(prefix: string, current: Record<string, FileHash>, baseline: Record<string, FileHash>): string[] {
  const out: string[] = [];
  const currentKeys = new Set(Object.keys(current));
  const baselineKeys = new Set(Object.keys(baseline));
  for (const key of [...currentKeys].filter((k) => !baselineKeys.has(k)).sort()) {
    out.push(`+ ${prefix} ${key}`);
  }
  for (const key of [...baselineKeys].filter((k) => !currentKeys.has(k)).sort()) {
    out.push(`- ${prefix} ${key}`);
  }
  for (const key of [...currentKeys].filter((k) => baselineKeys.has(k)).sort()) {
    const a = current[key]!;
    const b = baseline[key]!;
    if (a.sha256 !== b.sha256 || a.lines !== b.lines) {
      out.push(`~ ${prefix} ${key} sha=${a.sha256.slice(0, 8)} lines=${a.lines}（基线 sha=${b.sha256.slice(0, 8)} lines=${b.lines}）`);
    }
  }
  return out;
}

function diffImports(current: ImportEdge[], baseline: ImportEdge[]): string[] {
  const out: string[] = [];
  const key = (e: ImportEdge): string => `${e.from}\u0000${e.kind}\u0000${e.specifier}\u0000${e.target ?? ""}`;
  const currentKeys = new Set(current.map(key));
  const baselineKeys = new Set(baseline.map(key));
  for (const e of current) {
    if (!baselineKeys.has(key(e))) out.push(`+ import ${e.from} -> ${e.specifier}${e.target ? ` (${e.target})` : ""} [${e.kind}]`);
  }
  for (const e of baseline) {
    if (!currentKeys.has(key(e))) out.push(`- import ${e.from} -> ${e.specifier}${e.target ? ` (${e.target})` : ""} [${e.kind}]`);
  }
  return out.sort();
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--check")
    ? "check"
    : process.argv.includes("--update")
      ? "update"
      : "print";

  const current = await buildSnapshot();

  if (mode === "print") {
    process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
    return;
  }

  let baseline: StructureSnapshot | undefined;
  try {
    baseline = JSON.parse(await readFile(baselineJsonPath, "utf8")) as StructureSnapshot;
  } catch {
    baseline = undefined;
  }

  if (mode === "update") {
    await writeFile(baselineJsonPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    await writeFile(baselineMdPath, buildMarkdown(current), "utf8");
    process.stdout.write(
      `✅ 结构基线已写入：\n  ${posix(path.relative(repoRoot, baselineJsonPath))}\n  ${posix(path.relative(repoRoot, baselineMdPath))}\n` +
        `摘要：${current.summary.totalFiles} 文件 / ${current.summary.totalLines} 行 / ${current.summary.importEdges} 导入边\n`,
    );
    return;
  }

  // --check
  if (!baseline) {
    process.stderr.write(`❌ 基线缺失：${baselineJsonPath}\n先运行 --update 生成基线。\n`);
    process.exitCode = 1;
    return;
  }
  if (baseline.schemaVersion !== SCHEMA_VERSION) {
    process.stderr.write(`❌ 基线 schemaVersion=${String(baseline.schemaVersion)} ≠ ${SCHEMA_VERSION}，需人工处理。\n`);
    process.exitCode = 1;
    return;
  }

  const diffs: string[] = [];
  diffs.push(
    ...diffKeys("rootConfig", current.rootConfigs, baseline.rootConfigs),
    ...diffKeys("src/pth", current.srcPth, baseline.srcPth),
    ...diffKeys("test", current.tests, baseline.tests),
    ...diffKeys("scripts", current.scripts, baseline.scripts),
    ...diffKeys("packages", current.packages, baseline.packages),
    ...diffImports(current.imports, baseline.imports),
  );
  if (JSON.stringify(current.rootDirs) !== JSON.stringify(baseline.rootDirs)) {
    diffs.push(`~ rootDirs ${current.rootDirs.join(",")}（基线 ${baseline.rootDirs.join(",")}）`);
  }
  if (JSON.stringify(current.packagesMeta) !== JSON.stringify(baseline.packagesMeta)) {
    diffs.push("~ packagesMeta 变化（包名/版本变更）");
  }

  if (diffs.length === 0) {
    process.stdout.write("✅ 与基线无结构漂移。\n");
    return;
  }
  process.stdout.write(`❌ 结构漂移 ${diffs.length} 项——对照 lane 契约 §3 文件域逐条复核；预期内则 --update 刷新基线。\n`);
  for (const line of diffs) process.stdout.write(`  ${line}\n`);
  process.exitCode = 1;
}

void main();
