/**
 * pth-boundaries-core.ts — PTH 模块化 v2 P0-2 的 import 边界扫描核心。
 *
 * 规则（与 docs/superpowers/plans/2026-08-15-pth-modularization-v2.md P0-2 对齐）：
 *  - gateway/** 不 import KernelRuntime/DataWorldAccess，不访问 kernel.pool/kernel.dataWorld；
 *  - tasking/runner/execution/catalog 模块之间只 import 公共 API（index），不 import 他方
 *    storage adapter 或私有文件；
 *  - domain 模块不 import @away_from/pth-sandbox 运行时 adapter
 *    （impls/kernels/**、bootstrap/**、main.ts 除外）；
 *  - contracts/ 不 import fastify/pg/redis/@away_from/pth-sandbox。
 *
 * 本模块不依赖任何运行时框架；脚本与测试共用同一扫描实现。
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type BoundaryRule =
  | "gateway-kernel-import"
  | "gateway-kernel-member-access"
  | "cross-module-storage-adapter"
  | "cross-module-private-import"
  | "sandbox-runtime-adapter"
  | "contracts-forbidden-import";

export interface BoundaryViolation {
  rule: BoundaryRule;
  file: string;
  line: number;
  detail: string;
}

export interface ScannedImport {
  specifier: string;
  line: number;
  kind: "type" | "runtime";
  /** 相对路径 import 解析出的目标路径（含 .ts 归一化）；包 specifier 原样保留 */
  targetPath: string | null;
}

const CROSS_MODULES = ["tasking", "runner", "execution", "catalog", "bootstrap"] as const;
const CONTRACTS_FORBIDDEN = new Set(["fastify", "pg", "ioredis", "redis", "@away_from/pth-sandbox"]);
const SANDBOX_PACKAGE = "@away_from/pth-sandbox";
const SANDBOX_ALLOWED_PREFIXES = ["impls/kernels/", "bootstrap/"];
const SANDBOX_ALLOWED_FILES = new Set(["main.ts"]);

export function baselineKey(v: BoundaryViolation): string {
  return `${v.rule}\u0000${v.file}\u0000${v.detail}`;
}

function relPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function normalizeTsTarget(specifier: string): string {
  return specifier.endsWith(".js") ? specifier.slice(0, -3) + ".ts" : specifier;
}

export function resolveImportTarget(importerRel: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const dir = path.posix.dirname(importerRel);
  return normalizeTsTarget(path.posix.normalize(path.posix.join(dir, specifier)));
}

export function scanImports(source: string): ScannedImport[] {
  const out: ScannedImport[] = [];
  const lineOf = (index: number): number => source.slice(0, index).split("\n").length;

  const staticRe = /(?:import|export)\s+([^'"]*?)['"]([^'"]+)['"]/g;
  for (let m = staticRe.exec(source); m; m = staticRe.exec(source)) {
    const prefix = m[1] ?? "";
    const kind = /\btype\b/.test(prefix) ? "type" : "runtime";
    out.push({ specifier: m[2], line: lineOf(m.index), kind, targetPath: null });
  }

  // 动态 import() 在类型注解中的形态按 type 处理（P0 阶段不据此判运行时适配器）。
  const dynamicRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m = dynamicRe.exec(source); m; m = dynamicRe.exec(source)) {
    out.push({ specifier: m[1], line: lineOf(m.index), kind: "type", targetPath: null });
  }
  return out;
}

function memberAccessViolations(source: string, importerRel: string): BoundaryViolation[] {
  const out: BoundaryViolation[] = [];
  const re = /\bkernel\.(pool|dataWorld)\b/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const line = source.slice(0, m.index).split("\n").length;
    out.push({ rule: "gateway-kernel-member-access", file: importerRel, line, detail: `kernel.${m[1]}` });
  }
  return out;
}

export async function collectBoundaryViolations(srcRoot: string): Promise<BoundaryViolation[]> {
  const violations: BoundaryViolation[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const importerRel = relPosix(path.relative(srcRoot, abs));
        const source = await readFile(abs, "utf8");
        const imports = scanImports(source);

        for (const imp of imports) {
          const targetPath = imp.specifier.startsWith(".") ? resolveImportTarget(importerRel, imp.specifier) : null;
          const targetBase = targetPath ? path.posix.basename(targetPath) : imp.specifier;

          // contracts/ 纯度规则
          if (importerRel.startsWith("contracts/") && CONTRACTS_FORBIDDEN.has(imp.specifier)) {
            violations.push({ rule: "contracts-forbidden-import", file: importerRel, line: imp.line, detail: imp.specifier });
          }

          // gateway 不得 import KernelRuntime（kernel/assembly）或 DataWorldAccess（kernel/storage/index）
          if (
            importerRel.startsWith("gateway/") &&
            targetPath !== null &&
            (targetPath === "kernel/assembly.ts" || targetPath === "kernel/storage/index.ts")
          ) {
            violations.push({ rule: "gateway-kernel-import", file: importerRel, line: imp.line, detail: targetPath });
          }

          // 跨模块 storage adapter：tasking/runner/execution/catalog 不得 runtime-import
          // kernel/storage/* adapter；type-only 引用与 pg.ts 事务工具放行（adapter 本身可持有）。
          const module = importerRel.split("/")[0];
          if (
            (CROSS_MODULES as readonly string[]).includes(module) &&
            targetPath !== null &&
            targetPath.startsWith("kernel/storage/") &&
            targetPath !== "kernel/storage/pg.ts" &&
            imp.kind === "runtime"
          ) {
            violations.push({ rule: "cross-module-storage-adapter", file: importerRel, line: imp.line, detail: targetPath });
          }

          // 跨模块私有 import：模块之间只允许走他方 index.ts 公共 API
          if (
            (CROSS_MODULES as readonly string[]).includes(module) &&
            targetPath !== null &&
            targetPath.includes("/") &&
            (CROSS_MODULES as readonly string[]).includes(targetPath.split("/")[0]) &&
            targetPath.split("/")[0] !== module &&
            targetBase !== "index.ts"
          ) {
            violations.push({ rule: "cross-module-private-import", file: importerRel, line: imp.line, detail: targetPath });
          }

          // sandbox 运行时 adapter：type import 放行，runtime import 仅白名单目录可持
          if (imp.kind === "runtime" && imp.specifier === SANDBOX_PACKAGE) {
            const allowed =
              SANDBOX_ALLOWED_FILES.has(importerRel) ||
              SANDBOX_ALLOWED_PREFIXES.some((p) => importerRel.startsWith(p));
            if (!allowed) {
              violations.push({ rule: "sandbox-runtime-adapter", file: importerRel, line: imp.line, detail: imp.specifier });
            }
          }
        }

        if (importerRel.startsWith("gateway/")) {
          violations.push(...memberAccessViolations(source, importerRel));
        }
      }
    }
  }

  await walk(srcRoot);
  violations.sort((a, b) => baselineKey(a).localeCompare(baselineKey(b)) || a.line - b.line);
  return violations;
}

export async function loadBoundaryBaseline(file: string): Promise<BoundaryViolation[]> {
  const raw = await readFile(file, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${file}: baseline must be a JSON array`);
  return parsed as BoundaryViolation[];
}
