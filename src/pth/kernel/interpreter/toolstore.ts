/**
 * toolstore.ts — 文件存储通道（解释器持久化层 §0.5，T1b 遗留补全）
 *
 * "可饮用的文件"：工具函数 → .ts 文件（含 spec 注释头）、数据 → .json 文件。
 * 任务代码经 vm 白名单能力 fs.readText 读取 → strip 类型 → eval 重放（等效 import）。
 *
 * 安全边界（§0.5）：只读 <toolstore>/ 目录（路径前缀校验防目录穿越/绝对路径）；
 * 只读不写（写走既有 workspace/artifacts 机制）。
 */

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Toolstore {
  /** 写入（命名编译单元/agent 可写——路径白名单同 readText） */
  writeText(name: string, content: string): Promise<void>;
  /** 枚举子目录内容（命名编译单元 listUnits 用——顶层 list 只列文件） */
  listSubdir(subdir: string): Promise<string[]>;
  /** 枚举子目录（扩展包扫描——extensions/<id>/ 目录列表） */
  listDirs(subdir: string): Promise<string[]>;
  /** 读取 toolstore 内文件文本（.ts 源码 / .json 数据）——路径必须解析后仍在 toolstore 内 */
  readText(name: string): Promise<string>;
  /** 枚举可用文件（LLM 工具发现） */
  list(): Promise<string[]>;
}

function assertInside(root: string, resolved: string, name: string): void {
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`readText: path outside toolstore (${name})`);
  }
}

export function createToolstore(toolstoreDir: string): Toolstore {
  const root = path.resolve(toolstoreDir);
  return {
    async writeText(name, content) {
      const resolved = path.resolve(root, name);
      assertInside(root, resolved, name);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf8");
    },
    async readText(name) {
      const resolved = path.resolve(root, name);
      assertInside(root, resolved, name);
      try {
        return await readFile(resolved, "utf8");
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") throw new Error(`readText: ${name} not found in toolstore`);
        if (err.code === "EISDIR") throw new Error(`readText: ${name} is a directory`);
        throw e;
      }
    },
    async list() {
      return listToolstoreIndex(root);
    },
    async listDirs(subdir) {
      const resolved = path.resolve(root, subdir);
      assertInside(root, resolved, subdir);
      try {
        const entries = await readdir(resolved, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
    },
    async listSubdir(subdir) {
      const resolved = path.resolve(root, subdir);
      assertInside(root, resolved, subdir);
      try {
        const entries = await readdir(resolved, { withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => e.name);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
    },
  };
}

/** 枚举 toolstore 可用文件（LLM 工具发现——草案 P13 index 的简化形态） */
export async function listToolstoreIndex(toolstoreDir: string): Promise<string[]> {
  try {
    const entries = await readdir(toolstoreDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
