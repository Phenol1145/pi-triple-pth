/**
 * read-source.ts — 自修改 v1：PTH 源码只读通道（worker 读源码 → sandbox 编码 → 提交补丁）
 *
 * 安全：只读 + 白名单路径校验（仅 src/ 下 .ts 文件——防越权读 /etc、.env 等）。
 * 源码根：/app/src（容器内 PTH 源码——DATASOURCE 目录 env 可覆盖，测试注入临时目录）。
 */

import { readFile } from "node:fs/promises";
import { join, normalize, relative } from "node:path";

export function createReadSource(sourceRoot: string) {
  return async (relPath: string): Promise<string> => {
    if (typeof relPath !== "string" || relPath.trim() === "") {
      throw new Error("readSource: 需传相对路径（如 kernel/execution/worker-cluster.ts）");
    }
    // 白名单：仅 src/ 下 .ts 文件（源码只读面——排除配置/数据/密钥）
    if (!relPath.startsWith("src/") || !relPath.endsWith(".ts")) {
      throw new Error(`readSource: 仅允许 src/ 下 .ts 文件（拒绝: ${relPath.slice(0, 80)}）`);
    }
    const abs = normalize(join(sourceRoot, relPath));
    // 路径穿越防护（normalize 后仍须在 root 内）
    const rel = relative(sourceRoot, abs);
    if (rel.startsWith("..") || rel.startsWith("/") || rel === "") {
      throw new Error(`readSource: 路径越界（拒绝: ${relPath}）`);
    }
    try {
      return await readFile(abs, "utf8");
    } catch (e) {
      throw new Error(`readSource: 读取失败 ${relPath}: ${(e as Error).message}`);
    }
  };
}

/** 源码根探测（容器 /app/src——测试可注入） */
export function sourceRoot(): string {
  return process.env.PTH_SOURCE_ROOT ?? "/app/src";
}
