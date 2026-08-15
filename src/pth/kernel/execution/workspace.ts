import { mkdir, rename, cp, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { TaskWorkspaceManager } from "./task-loop.js";

/**
 * 任务级工作区（裁决 18）：认领分配 → 提交归档 → 清理。
 * 路径：workspaces/<tenant>/tasks/<taskId>/（sandbox 白名单）
 * P0-3：tenant 目录与任务目录 0700——sandbox workload（不同 UID）不可读其他租户；
 * workload 文件访问经 sandbox 私有工作区 broker 拷贝。
 * 归档：整个任务工作区 rename 到 artifacts/<taskId>/（v1 简化，不提炼）
 */
export class DefaultTaskWorkspaceManager implements TaskWorkspaceManager {
  constructor(private deps: { basePath: string; artifactPath: string }) {}

  async allocate(taskId: string, tenantId = "default"): Promise<{ dir: string; tenant: string }> {
    const safeTenant = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(tenantId) ? tenantId : "default";
    const tenantDir = join(this.deps.basePath, safeTenant);
    const dir = join(tenantDir, "tasks", taskId);
    await mkdir(tenantDir, { recursive: true, mode: 0o700 });
    await chmod(tenantDir, 0o700).catch(() => {});
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    return { dir, tenant: safeTenant };
  }

  async archive(taskId: string, dir: string): Promise<{ artifactPath: string }> {
    const artifactPath = join(this.deps.artifactPath, taskId);
    try {
      await rename(dir, artifactPath);    // 整目录 rename（v1；产物指针入 pg）
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        // 跨设备（workspaces 卷 → artifacts 目录/另一卷）：fallback 复制+删除
        await cp(dir, artifactPath, { recursive: true });
        await rm(dir, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
    return { artifactPath };
  }
}
