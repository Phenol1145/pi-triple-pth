import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolstore, listToolstoreIndex } from "../../src/pth/kernel/interpreter/toolstore";

describe("toolstore 文件通道", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pth-toolstore-"));
    await writeFile(join(dir, "add.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
    await writeFile(join(dir, "data.json"), '{"aabb": {"accepted": true, "steps": 13}}');
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("readText 读取 .ts 文件（工具函数源码）", async () => {
    const ts = createToolstore(dir);
    const src = await ts.readText("add.ts");
    expect(src).toContain("function add");
  });

  it("readText 读取 .json 数据文件", async () => {
    const ts = createToolstore(dir);
    const data = JSON.parse(await ts.readText("data.json"));
    expect(data.aabb.steps).toBe(13);
  });

  it("路径前缀校验：拒绝目录穿越（../ 越权读）", async () => {
    const ts = createToolstore(dir);
    await expect(ts.readText("../../etc/passwd")).rejects.toThrow(/outside toolstore/i);
  });

  it("路径前缀校验：拒绝绝对路径", async () => {
    const ts = createToolstore(dir);
    await expect(ts.readText("/etc/passwd")).rejects.toThrow(/outside toolstore/i);
  });

  it("不存在文件 → 明确错误", async () => {
    const ts = createToolstore(dir);
    await expect(ts.readText("nope.ts")).rejects.toThrow(/not found/i);
  });

  it("listToolstoreIndex 枚举可用工具（文件名列表）", async () => {
    const index = await listToolstoreIndex(dir);
    expect(index).toContain("add.ts");
    expect(index).toContain("data.json");
  });
});
