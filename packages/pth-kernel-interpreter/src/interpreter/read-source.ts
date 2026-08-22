/**
 * read-source.ts — 自修改 v1：PTH 源码只读通道（worker 读源码 → sandbox 编码 → 提交补丁）
 *
 * 安全：只读 + 白名单路径校验（仅 src/ 下 .ts 文件——防越权读 /etc、.env 等）。
 * 源码根：/app/src（容器内 PTH 源码——DATASOURCE 目录 env 可覆盖，测试注入临时目录）。
 * S0-4（2026-08-16）：realpath 父目录 + lstat 拒绝 symlink 文件/目录组件。
 * 残余 TOCTOU（lstat 与 open 之间被替换为 symlink）为已接受边界——本地可信源码根 + 只读面。
 */

import { readFile, realpath, lstat } from "node:fs/promises";
import { basename, dirname, join, normalize, relative } from "node:path";
import { pthConfig } from "@away_from/pth-config";

export function createReadSource(sourceRoot: string) {
  return async (relPath: string): Promise<string> => {
    if (typeof relPath !== "string" || relPath.trim() === "") {
      throw new Error("readSource: 需传相对路径（如 kernel/execution/worker-cluster.ts）");
    }
    // 兼容两种写法：sourceRoot 已含 src/（/app/src）——relPath 可带 src/ 前缀或相对内部
    const clean = relPath.startsWith("src/") ? relPath.slice(4) : relPath;
    // 白名单：仅 .ts 源码（只读面——排除配置/数据/密钥）
    if (!clean.endsWith(".ts")) {
      throw new Error(`readSource: 仅允许 .ts 源码（拒绝: ${relPath.slice(0, 80)}）`);
    }
    const abs = normalize(join(sourceRoot, clean));
    // 词法路径穿越防护（normalize 后仍须在 root 内）
    const rel = relative(sourceRoot, abs);
    if (rel.startsWith("..") || rel.startsWith("/") || rel === "") {
      throw new Error(`readSource: 路径越界（拒绝: ${relPath}）`);
    }
    try {
      // symlink 防线：root 与目标父目录都取 realpath，最后 lstat 拒绝 symlink 文件
      const realRoot = await realpath(sourceRoot);
      const realParent = await realpath(dirname(abs));
      const finalPath = join(realParent, basename(abs));
      const finalRel = relative(realRoot, finalPath);
      if (finalRel.startsWith("..") || finalRel.startsWith("/") || finalRel === "") {
        throw new Error(`readSource: 路径越界（拒绝: ${relPath}）`);
      }
      const st = await lstat(finalPath);
      if (st.isSymbolicLink()) {
        throw new Error(`readSource: symlink 被拒（拒绝: ${relPath}）`);
      }
      return await readFile(finalPath, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.message?.includes("readSource:")) throw err;
      throw new Error(`readSource: 读取失败 ${relPath}: ${err.message ?? err}`);
    }
  };
}

/** 源码根探测（容器 /app/src——测试可注入） */
export function sourceRoot(): string {
  return pthConfig().str("PTH_SOURCE_ROOT");
}
