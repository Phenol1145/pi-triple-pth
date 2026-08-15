vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (async (from: string, to: string) => {
      if ((globalThis as any).__EXDEV_INJECT__) {
        const err: any = new Error("EXDEV: cross-device link not permitted");
        err.code = "EXDEV";
        throw err;
      }
      return (actual.rename as any)(from, to);
    }) as typeof actual.rename,
  };
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultTaskWorkspaceManager } from "../../src/pth/kernel/execution/workspace";

describe("task workspace", () => {
  let base: string;
  let artifacts: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "pth-ws-"));
    artifacts = join(base, "artifacts");
    await mkdir(artifacts, { recursive: true });
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("allocate creates task dir under base/<tenant>/tasks/<taskId>（P0-3 租户隔离）", async () => {
    const mgr = new DefaultTaskWorkspaceManager({ basePath: base, artifactPath: artifacts });
    const ws = await mgr.allocate("task-1");
    expect(ws.dir).toBe(join(base, "default", "tasks", "task-1"));
    expect(existsSync(ws.dir)).toBe(true);
    expect(ws.tenant).toBe("default");
  });

  it("archive renames task dir to artifacts/<taskId>", async () => {
    const mgr = new DefaultTaskWorkspaceManager({ basePath: base, artifactPath: artifacts });
    const ws = await mgr.allocate("task-2");
    await writeFile(join(ws.dir, "output.txt"), "hello");
    const { artifactPath } = await mgr.archive("task-2", ws.dir);
    expect(artifactPath).toBe(join(artifacts, "task-2"));
    expect(existsSync(artifactPath)).toBe(true);
    expect((await readdir(artifactPath)).join(",")).toContain("output.txt");
    // 原工作区已 rename（不存在）
    expect(existsSync(ws.dir)).toBe(false);
  });

  it("archive is idempotent-safe for missing dir (throws gracefully)", async () => {
    const mgr = new DefaultTaskWorkspaceManager({ basePath: base, artifactPath: artifacts });
    await expect(mgr.archive("task-ghost", join(base, "default", "tasks", "task-ghost"))).rejects.toThrow();
  });
});

describe("archive EXDEV fallback", () => {
  it("rename 跨设备失败 → 复制+删除（产物完整落 artifacts）", async () => {
    const { DefaultTaskWorkspaceManager } = await import("../../src/pth/kernel/execution/workspace.js");
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ws-xdev-"));
    const artRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "art-xdev-"));
    const taskDir = path.join(wsRoot, "default", "tasks", "t-xdev");
    await fsp.mkdir(taskDir, { recursive: true });
    await fsp.writeFile(path.join(taskDir, "payload.json"), "{}");
    const mgr = new DefaultTaskWorkspaceManager({ basePath: wsRoot, artifactPath: artRoot });
    // 注入 EXDEV：rename 首次调用抛跨设备错误 → 触发 fallback
    (globalThis as any).__EXDEV_INJECT__ = true;
    try {
      const { artifactPath } = await mgr.archive("t-xdev", taskDir);
      expect(await fsp.readFile(path.join(artifactPath, "payload.json"), "utf8")).toBe("{}");
      await expect(fsp.access(taskDir)).rejects.toThrow(); // 源已清理
    } finally {
      (globalThis as any).__EXDEV_INJECT__ = false;
      await fsp.rm(wsRoot, { recursive: true, force: true });
      await fsp.rm(artRoot, { recursive: true, force: true });
    }
  });
});
