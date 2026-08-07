import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { TaskWorkspaceManager } from "./task-loop.js";

/**
 * 任务级工作区（裁决 18）：认领分配 → 提交归档 → 清理。
 * 路径：workspaces/<tenant>/tasks/<taskId>/（sandbox 白名单）
 * 归档：整个任务工作区 rename 到 artifacts/<taskId>/（v1 简化，不提炼）
 */
export class DefaultTaskWorkspaceManager implements TaskWorkspaceManager {
  constructor(private deps: { basePath: string; artifactPath: string }) {}

  async allocate(taskId: string): Promise<{ dir: string; tenant: string }> {
    const dir = join(this.deps.basePath, "tasks", taskId);
    await mkdir(dir, { recursive: true });
    return { dir, tenant: "default" };
  }

  async archive(taskId: string, dir: string): Promise<{ artifactPath: string }> {
    const artifactPath = join(this.deps.artifactPath, taskId);
    await rename(dir, artifactPath);    // 整目录 rename（v1；产物指针入 pg）
    return { artifactPath };
  }
}
