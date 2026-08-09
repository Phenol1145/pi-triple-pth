import { describe, it, expect } from "vitest";
import { createReadSource } from "../../src/pth/kernel/interpreter/read-source.js";
import { SELF_MODIFY_GUIDE } from "../../src/pth/kernel/self-modify.js";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("自修改 v1（PTH 自己修改自己——单步）", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sm-"));
    await mkdir(join(root, "src", "pth", "kernel"), { recursive: true });
    await writeFile(join(root, "src", "pth", "kernel", "worker-cluster.ts"), "export const X = 1;\n");
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it("readSource：读 src/ 下 .ts 源码（白名单）", async () => {
    const rs = createReadSource(root);
    const content = await rs("src/pth/kernel/worker-cluster.ts");
    expect(content).toContain("export const X");
  });

  it("readSource：拒绝白名单外（非 src/ 或非 .ts）", async () => {
    const rs = createReadSource(root);
    await expect(rs("../etc/passwd")).rejects.toThrow(/仅允许/);
    await expect(rs("src/pth/kernel/config.json")).rejects.toThrow(/仅允许/);
    await expect(rs("kernel/worker-cluster.ts")).rejects.toThrow(/仅允许/);
  });

  it("readSource：路径穿越防护", async () => {
    const rs = createReadSource(root);
    await expect(rs("src/../../etc/passwd")).rejects.toThrow();
  });

  it("自修改指南含源码布局/修改流程/不变量", () => {
    expect(SELF_MODIFY_GUIDE).toContain("src/pth/kernel/execution");
    expect(SELF_MODIFY_GUIDE).toContain("fs.readSource");
    expect(SELF_MODIFY_GUIDE).toContain("不删除/移动 .pi-platform-data");
    expect(SELF_MODIFY_GUIDE).toContain("npx vitest run");
  });
});
