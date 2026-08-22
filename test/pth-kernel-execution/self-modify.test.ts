import { describe, it, expect } from "vitest";
import { createReadSource } from "@away_from/pth-kernel-interpreter";
import { SELF_MODIFY_GUIDE } from "@away_from/pth-kernel-execution";
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

  it("readSource：读 src/ 下 .ts 源码（白名单——sourceRoot 指向 src 目录）", async () => {
    const rs = createReadSource(join(root, "src"));
    const content = await rs("pth/kernel/worker-cluster.ts");
    expect(content).toContain("export const X");
    // 兼容带 src/ 前缀写法
    const content2 = await rs("src/pth/kernel/worker-cluster.ts");
    expect(content2).toContain("export const X");
  });

  it("readSource：拒绝白名单外（非 .ts）", async () => {
    const rs = createReadSource(join(root, "src"));
    await expect(rs("../../etc/passwd")).rejects.toThrow();
    await expect(rs("pth/kernel/config.json")).rejects.toThrow(/仅允许/);
  });

  it("readSource：路径穿越防护", async () => {
    const rs = createReadSource(join(root, "src"));
    await expect(rs("../../etc/passwd")).rejects.toThrow();
  });

  it("自修改指南含源码布局/修改流程/不变量", () => {
    expect(SELF_MODIFY_GUIDE).toContain("src/pth/kernel/execution");
    expect(SELF_MODIFY_GUIDE).toContain("fs.readSource");
    expect(SELF_MODIFY_GUIDE).toContain("不删除/移动 .pi-platform-data");
    expect(SELF_MODIFY_GUIDE).toContain("npx vitest run");
  });
});
