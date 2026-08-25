/**
 * scripts/check/check-product-boundaries.ts —— PTL/PTH 产品边界机械检查。
 *
 * 归属规则见 docs/pth/module-ownership.md。只检查 import 目标的前缀方向，
 * 不替代 pth-boundaries（模块内 barrel 规则）。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const PTH_CORE_PREFIXES = [
  "src/pth/",
  "packages/pth-memory/src/",
  "packages/pth-sandbox/src/",
  "packages/pth-console/src/",
];

const PTL_ONLY_PREFIXES = [
  "packages/framework/src/cli/",
  "packages/framework/src/commands/",
  "packages/framework/src/containers/",
  "packages/framework/src/program-dev/",
  "packages/framework/src/stack/",
  "packages/framework/src/session/",
  "packages/framework/src/tui-",
  "packages/mailbox/src/",
  "packages/dev-container/src/",
];

const PTL_PACKAGE_TARGETS = ["@away_from/framework", "@away_from/mailbox", "@away_from/dev-container"];
const PTH_PACKAGE_TARGETS = [
  "@away_from/pth-console",
  "@away_from/pth-memory",
  "@away_from/pth-sandbox",
];

const PTL_ONLY_FILES = new Set([
  "packages/framework/src/env.ts",
  "packages/framework/src/extension-copy.ts",
  "packages/framework/src/launcher.ts",
  "packages/framework/src/migrate.ts",
  "packages/framework/src/pit.ts",
  "packages/framework/src/shared-layer.ts",
]);

const TRANSITIONAL_PREFIXES = [
  "packages/pth-console/src/bridge/",
  "packages/pth-console/src/operator-console/",
];

const SCAN_ROOTS = ["src", "packages"];
const IGNORE_DIRS = new Set(["node_modules", "dist", ".git"]);

export interface ProductBoundaryViolation {
  rule: "pth-imports-ptl" | "ptl-imports-pth";
  file: string;
  line: number;
  target: string;
}

export interface ProductBoundaryReport {
  violations: ProductBoundaryViolation[];
  transitionalFiles: string[];
  scannedFiles: number;
}

function relOf(file: string): string {
  return relative(root, file).split("\\").join("/");
}

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // 拆仓后某仓库可能没有 src/（如 pi-triple-ptl）——扫描根缺省跳过
  }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

function importTargets(source: string): Array<{ line: number; target: string }> {
  const out: Array<{ line: number; target: string }> = [];
  const re = /(?:import|export)[^;'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const target = (match[1] ?? match[2] ?? "").trim();
    if (!target || target.startsWith("node:") || target.startsWith(".")) continue;
    out.push({ line: lineAt(source, match.index), target });
  }
  return out;
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function isPthCore(file: string): boolean {
  const rel = relOf(file);
  return PTH_CORE_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function isPtlOnly(file: string): boolean {
  const rel = relOf(file);
  return PTL_ONLY_FILES.has(rel) || PTL_ONLY_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function isTransitional(file: string): boolean {
  const rel = relOf(file);
  return TRANSITIONAL_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

export function collectProductBoundaryViolations(roots: string[] = SCAN_ROOTS): ProductBoundaryReport {
  const files = roots.flatMap((scanRoot) => walk(resolve(root, scanRoot)));
  const violations: ProductBoundaryViolation[] = [];
  const transitionalFiles: string[] = [];
  for (const file of files) {
    const rel = relOf(file);
    if (isTransitional(file)) {
      transitionalFiles.push(rel);
    }
    const pth = isPthCore(file);
    const ptl = isPtlOnly(file);
    if (!pth && !ptl) continue;
    const source = readFileSync(file, "utf8");
    for (const imp of importTargets(source)) {
      const target = imp.target;
      const pthTarget = PTH_PACKAGE_TARGETS.includes(target) || PTH_CORE_PREFIXES.some((prefix) => target.startsWith(prefix.replace(/\/$/, "/")));
      const ptlTarget = PTL_PACKAGE_TARGETS.includes(target) || PTL_ONLY_FILES.has(target) || PTL_ONLY_PREFIXES.some((prefix) => target.startsWith(prefix.replace(/\/$/, "/")));
      if (pth && ptlTarget) {
        violations.push({ rule: "pth-imports-ptl", file: rel, line: imp.line, target });
      }
      if (ptl && pthTarget) {
        violations.push({ rule: "ptl-imports-pth", file: rel, line: imp.line, target });
      }
    }
  }
  return { violations, transitionalFiles, scannedFiles: files.length };
}

const invokedDirectly = process.argv[1]?.endsWith("check-product-boundaries.ts") ?? false;
if (invokedDirectly) {
  const report = collectProductBoundaryViolations();
  console.log(`── product-boundaries：扫描 ${report.scannedFiles} 文件 · 过渡区 ${report.transitionalFiles.length} 个`);
  if (report.violations.length > 0) {
    for (const violation of report.violations) {
      console.error(`  ❌ ${violation.rule} ${violation.file}:${violation.line} → ${violation.target}`);
    }
    process.exit(1);
  }
  console.log("✅ PTL/PTH 产品边界无违规");
  process.exit(0);
}
