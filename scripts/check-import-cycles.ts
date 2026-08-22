#!/usr/bin/env tsx
/**
 * check-import-cycles.ts — PTH 引擎 import 环检测 CLI/库。
 *
 * 用法：
 *   npm run check:import-cycles                # 与基线比较；新增 static-runtime 环 → 非零退出
 *   npm run check:import-cycles -- --update    # 用当前 static-runtime 环刷新基线（阶段收账用）
 *
 * 图范围：
 *   - src/pth/**、src/cli/**、packages/<pkg>/src/** 的 git 跟踪 .ts/.tsx 文件
 *   - 解析静态 import/export from（区分 type-only 与 runtime）与动态 import()
 *
 * 门禁语义：
 *   - static-runtime SCC 必须 ⊆ scripts/import-cycles.baseline.json
 *   - static-all / dynamic 仅输出报告，不阻塞（当前仍有 type/dynamic 环）
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export interface ImportEdge {
  from: string;
  to: string;
  kind: "static-runtime" | "static-type" | "dynamic";
}

export interface CycleReport {
  files: string[];
  edges: ImportEdge[];
  staticRuntime: string[][];
  staticAll: string[][];
  dynamic: string[][];
}

const BASELINE_FILE = "scripts/import-cycles.baseline.json";
const SCAN_PATTERNS = [
  "src/pth/**/*.ts",
  "src/pth/**/*.tsx",
  "src/cli/**/*.ts",
  "src/cli/**/*.tsx",
  "packages/*/src/**/*.ts",
  "packages/*/src/**/*.tsx",
];

function relPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function normalizeSpecifier(specifier: string): string {
  return specifier.replace(/\.js$/, "").replace(/\.tsx?$/, "");
}

function resolveRelative(fromRel: string, specifier: string, files: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const dir = path.posix.dirname(fromRel);
  const base = normalizeSpecifier(specifier);
  const target = path.posix.normalize(path.posix.join(dir, base));
  const candidates = [
    `${target}.ts`,
    `${target}.tsx`,
    `${target}/index.ts`,
    `${target}/index.tsx`,
  ];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function importDeclarationIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    return clause.namedBindings.elements.every((el) => el.isTypeOnly);
  }
  return false;
}

function exportDeclarationIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause && ts.isNamedExports(clause)) {
    return clause.elements.every((el) => el.isTypeOnly);
  }
  return false;
}

function scanSourceFile(fileRel: string, source: string, files: Set<string>): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const sf = ts.createSourceFile(fileRel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const specifier = (stmt.moduleSpecifier as ts.StringLiteral).text;
      const to = resolveRelative(fileRel, specifier, files);
      if (!to) continue;
      edges.push({
        from: fileRel,
        to,
        kind: importDeclarationIsTypeOnly(stmt) ? "static-type" : "static-runtime",
      });
    } else if (ts.isExportDeclaration(stmt)) {
      const specifier = stmt.moduleSpecifier?.text;
      if (!specifier) continue;
      const to = resolveRelative(fileRel, specifier, files);
      if (!to) continue;
      edges.push({
        from: fileRel,
        to,
        kind: exportDeclarationIsTypeOnly(stmt) ? "static-type" : "static-runtime",
      });
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      const specifier = (node.arguments[0] as ts.StringLiteral).text;
      const to = resolveRelative(fileRel, specifier, files);
      if (to) {
        edges.push({ from: fileRel, to, kind: "dynamic" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return edges;
}

export async function collectImportGraph(): Promise<{ files: string[]; edges: ImportEdge[] }> {
  const repoRoot = process.cwd();
  const tracked = execFileSync("git", ["ls-files", "--", ...SCAN_PATTERNS], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(relPosix)
    .filter((file) => /\.(ts|tsx)$/.test(file));

  const fileSet = new Set(tracked);
  const edges: ImportEdge[] = [];

  for (const file of tracked) {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    edges.push(...scanSourceFile(file, source, fileSet));
  }

  edges.sort((a, b) => `${a.from}\u0000${a.to}\u0000${a.kind}`.localeCompare(`${b.from}\u0000${b.to}\u0000${b.kind}`));
  return { files: tracked, edges };
}

function findSccs(nodes: string[], edges: ImportEdge[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const node of nodes) graph.set(node, []);
  for (const edge of edges) {
    const list = graph.get(edge.from);
    if (list) list.push(edge.to);
  }

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  const strongConnect = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        strongConnect(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!));
      }
    }

    if (low.get(node) === index.get(node)) {
      const scc: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        scc.push(member);
      } while (member !== node);
      if (scc.length > 1) {
        scc.sort();
        sccs.push(scc);
      }
    }
  };

  for (const node of nodes) {
    if (!index.has(node)) strongConnect(node);
  }

  sccs.sort((a, b) => a.join(" -> ").localeCompare(b.join(" -> ")));
  return sccs;
}

export async function analyzeImportCycles(): Promise<CycleReport> {
  const { files, edges } = await collectImportGraph();
  const staticRuntimeEdges = edges.filter((edge) => edge.kind === "static-runtime");
  const staticAllEdges = edges.filter((edge) => edge.kind === "static-runtime" || edge.kind === "static-type");
  const dynamicEdges = edges.filter((edge) => edge.kind === "dynamic");

  const staticRuntime = findSccs(files, staticRuntimeEdges);
  const staticAll = findSccs(files, staticAllEdges);
  const dynamic = findSccs(files, dynamicEdges);

  return { files, edges, staticRuntime, staticAll, dynamic };
}

function cycleKey(scc: string[]): string {
  return scc.join(" -> ");
}

export async function loadImportCycleBaseline(file = BASELINE_FILE): Promise<string[]> {
  const raw = await readFile(file, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${file}: baseline must be a JSON array of cycle strings`);
  return parsed as string[];
}

async function main(): Promise<void> {
  const update = process.argv.includes("--update");
  const report = await analyzeImportCycles();

  console.log("── import-cycles 报告 ──");
  console.log(`files: ${report.files.length}`);
  console.log(`edges: ${report.edges.length} (static-runtime ${report.edges.filter((e) => e.kind === "static-runtime").length}, static-type ${report.edges.filter((e) => e.kind === "static-type").length}, dynamic ${report.edges.filter((e) => e.kind === "dynamic").length})`);
  console.log(`static-runtime SCCs: ${report.staticRuntime.length}`);
  for (const scc of report.staticRuntime) console.log(`  ${cycleKey(scc)}`);
  console.log(`static-all SCCs: ${report.staticAll.length}`);
  for (const scc of report.staticAll) console.log(`  ${cycleKey(scc)}`);
  console.log(`dynamic SCCs: ${report.dynamic.length}`);
  for (const scc of report.dynamic) console.log(`  ${cycleKey(scc)}`);

  const currentKeys = report.staticRuntime.map(cycleKey);
  if (update) {
    await writeFile(BASELINE_FILE, `${JSON.stringify(currentKeys, null, 2)}\n`, "utf8");
    console.log(`baseline written: ${BASELINE_FILE} (${currentKeys.length})`);
    return;
  }

  const baseline = await loadImportCycleBaseline();
  const baselineSet = new Set(baseline);
  const added = currentKeys.filter((key) => !baselineSet.has(key));
  if (added.length > 0) {
    console.log(`── 新增 static-runtime 环 ${added.length} 条（必须修复或先入账）──`);
    for (const key of added) console.log(`  ${key}`);
    process.exit(1);
  }
  if (baseline.length > currentKeys.length) {
    console.log(`── 已修复 ${baseline.length - currentKeys.length} 条 static-runtime 环（可用 --update 收紧基线）──`);
  }
  console.log("✅ 无新增 static-runtime import 环");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main();
}
