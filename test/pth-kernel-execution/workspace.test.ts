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

  it("allocate creates task dir under base/tasks/<taskId>", async () => {
    const mgr = new DefaultTaskWorkspaceManager({ basePath: base, artifactPath: artifacts });
    const ws = await mgr.allocate("task-1");
    expect(ws.dir).toBe(join(base, "tasks", "task-1"));
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
    await expect(mgr.archive("task-ghost", join(base, "tasks", "task-ghost"))).rejects.toThrow();
  });
});
