import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createReadSource } from "@away_from/pth-kernel-interpreter";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("readSource symlink 防线（S0-4）", () => {
  let root: string;
  let outsideDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "readsource-"));
    outsideDir = await mkdtemp(join(tmpdir(), "readsource-outside-"));
    await mkdir(join(root, "src", "pth", "kernel"), { recursive: true });
    await writeFile(join(root, "src", "pth", "kernel", "worker-cluster.ts"), "export const X = 1;\n");
    await writeFile(join(outsideDir, "secret.ts"), "export const SECRET = 'root-outside';\n");
    // symlink 文件：src 内指向 src 根外文件
    await symlink(join(outsideDir, "secret.ts"), join(root, "src", "pth", "kernel", "leak.ts"));
    // symlink 目录组件：src 内目录指向 src 根外目录
    await symlink(outsideDir, join(root, "src", "linkdir"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("正常源码读取不受影响", async () => {
    const rs = createReadSource(join(root, "src"));
    expect(await rs("pth/kernel/worker-cluster.ts")).toContain("export const X");
  });

  it("拒绝 symlink 文件（指向根外）", async () => {
    const rs = createReadSource(join(root, "src"));
    await expect(rs("pth/kernel/leak.ts")).rejects.toThrow(/symlink/);
  });

  it("拒绝 symlink 目录组件", async () => {
    const rs = createReadSource(join(root, "src"));
    await expect(rs("linkdir/secret.ts")).rejects.toThrow(/symlink|越界|读取失败/);
  });
});
