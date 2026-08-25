#!/usr/bin/env node
/**
 * scripts/check/check-doc-links.ts —— docs 相对链接校验（搬迁安全网）。
 *
 * 只校验仓库内相对链接（忽略 http/https/mailto/纯锚点）；任何目标缺失 → exit 1。
 * 物理搬迁文档前必须本脚本全绿；如有无法修复的历史外链，用 --allow <path> 显式豁免。
 */

import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export interface DocLinkIssue {
  file: string;
  line: number;
  target: string;
  reason: "missing" | "unreadable";
}

const MD_EXT = /\.md$/;

export function collectDocLinkIssues(roots: string[], allow: string[] = []): DocLinkIssue[] {
  const allowSet = new Set(allow.map((entry) => resolve(root, entry)));
  const files: string[] = [];
  for (const scanRoot of roots) {
    walk(resolve(root, scanRoot), (file) => {
      if (MD_EXT.test(file)) files.push(file);
    });
  }
  const issues: DocLinkIssue[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
      let match: RegExpExecArray | null;
      while ((match = linkRe.exec(line))) {
        const raw = match[1]!.trim();
        const clean = raw.split("#")[0]!.split("?")[0]!;
        if (!clean || raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("mailto:")) continue;
        if (raw.startsWith("<") && raw.endsWith(">")) continue;
        const target = resolve(dirname(file), decodeURIComponent(clean));
        if (allowSet.has(target)) continue;
        if (!existsSync(target)) {
          issues.push({
            file: relative(root, file),
            line: i + 1,
            target: raw,
            reason: "missing",
          });
        }
      }
    }
  }
  return issues;
}

function walk(dir: string, onFile: (file: string) => void): void {
  for (const name of readdirSyncSafe(dir)) {
    const full = resolve(dir, name);
    if (isDirectorySafe(full)) walk(full, onFile);
    else onFile(full);
  }
}

import { readdirSync, statSync } from "node:fs";
function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
function isDirectorySafe(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

const invokedDirectly = process.argv[1]?.endsWith("check-doc-links.ts") ?? false;
if (invokedDirectly) {
  const allowArg = process.argv.indexOf("--allow");
  const allow: string[] = [];
  for (let i = allowArg + 1; allowArg >= 0 && i < process.argv.length && !process.argv[i]!.startsWith("-"); i += 1) {
    allow.push(process.argv[i]!);
  }
  const issues = collectDocLinkIssues(["docs", "README.md", "ARCHITECTURE.md", "TODO.md"], allow);
  if (issues.length > 0) {
    for (const issue of issues) console.error(`❌ ${issue.file}:${issue.line} → ${issue.target} (${issue.reason})`);
    console.error(`doc links: ${issues.length} broken`);
    process.exit(1);
  }
  console.log("✅ doc links: all relative targets exist");
}
