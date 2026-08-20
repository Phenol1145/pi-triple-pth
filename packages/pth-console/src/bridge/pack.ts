/**
 * bridge/pack.ts — agent 程序打包器
 *
 * 读目录 → 校验 agent.json → 收集文件 → ustar → gzip → 上限校验
 */
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { writeUstar } from "./ustar.js";
import { validateManifest, type ProgramManifest } from "./manifest.js";

/** 包上限 */
const MAX_FILES = 100;
const MAX_SINGLE_FILE = 1 * 1024 * 1024;  // 1MB
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_COMPRESSED = 2 * 1024 * 1024;   // 2MB

export interface PackResult {
  ok: true;
  archive: Buffer;       // gz 压缩的 ustar 归档
  manifest: ProgramManifest;
  files: string[];       // 打包的文件清单
  bytes: number;         // 压缩后大小
}
export interface PackErrors {
  ok: false;
  errors: string[];
}

/**
 * 递归收集目录文件（拒 symlink + `..`）；返回相对路径 + Buffer 列表。
 */
function collectFiles(dir: string): { ok: true; files: { relPath: string; content: Buffer }[] } | { ok: false; errors: string[] } {
  const result: { relPath: string; content: Buffer }[] = [];
  const errors: string[] = [];

  function walk(current: string, prefix: string) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err: any) {
      errors.push(`无法读取目录 ${prefix || "."}: ${err.message}`);
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(current, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // 拒绝 symlink
      try {
        if (fs.lstatSync(fullPath).isSymbolicLink()) {
          errors.push(`${relPath}: 不允许 symlink`);
          continue;
        }
      } catch (err: any) {
        errors.push(`${relPath}: ${err.message}`);
        continue;
      }

      if (entry.isDirectory()) {
        // 跳过隐藏目录（.git .node_modules 等）
        if (entry.name.startsWith(".")) continue;
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        // 跳过隐藏文件
        if (entry.name.startsWith(".")) continue;

        if (result.length >= MAX_FILES) {
          errors.push(`文件数超过上限 ${MAX_FILES}`);
          return;
        }

        let content: Buffer;
        try {
          content = fs.readFileSync(fullPath);
        } catch (err: any) {
          errors.push(`${relPath}: 读取失败: ${err.message}`);
          continue;
        }

        if (content.length > MAX_SINGLE_FILE) {
          errors.push(`${relPath}: 文件过大 (${(content.length / 1024 / 1024).toFixed(1)}MB，上限 1MB)`);
          continue;
        }

        result.push({ relPath, content });
      }
    }
  }

  walk(dir, "");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, files: result };
}

/**
 * 打包目录为 .tar.gz。
 * dir 必须是包含 agent.json 的合法程序目录。
 */
export function packProgram(dir: string): PackResult | PackErrors {
  const absDir = path.resolve(dir);

  // 1. 读 agent.json
  let manifestRaw: unknown;
  try {
    const raw = fs.readFileSync(path.join(absDir, "agent.json"), "utf-8");
    manifestRaw = JSON.parse(raw);
  } catch (err: any) {
    return {
      ok: false,
      errors: [`无法读取 agent.json: ${err.message}`],
    };
  }

  // 2. 校验 manifest
  const validated = validateManifest(manifestRaw);
  if (!validated.ok) return validated;

  // 3. 检查 systemPrompt 和 skills 文件存在性
  const manifest = validated.manifest;
  if (manifest.systemPrompt && !fs.existsSync(path.join(absDir, manifest.systemPrompt))) {
    return { ok: false, errors: [`systemPrompt 文件不存在: ${manifest.systemPrompt}`] };
  }
  if (manifest.skills) {
    for (const skill of manifest.skills) {
      if (!fs.existsSync(path.join(absDir, skill))) {
        return { ok: false, errors: [`skill 目录不存在: ${skill}`] };
      }
    }
  }

  // 4. 收集文件
  const collected = collectFiles(absDir);
  if (!collected.ok) return collected;

  // 5. 上限校验
  const totalBytes = collected.files.reduce((sum, f) => sum + f.content.length, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return { ok: false, errors: [`总文件大小 ${(totalBytes / 1024 / 1024).toFixed(1)}MB 超过上限 20MB`] };
  }

  // 6. ustar + gzip
  const ustar = writeUstar(collected.files.map((f) => ({ path: f.relPath, content: f.content })));
  const compressed = gzipSync(ustar);

  if (compressed.length > MAX_COMPRESSED) {
    return { ok: false, errors: [`压缩包 ${(compressed.length / 1024 / 1024).toFixed(1)}MB 超过上限 2MB`] };
  }

  return {
    ok: true,
    archive: compressed,
    manifest,
    files: collected.files.map((f) => f.relPath),
    bytes: compressed.length,
  };
}
