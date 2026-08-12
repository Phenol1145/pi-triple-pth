import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createWorkerKernelWithManager, createKernelManager } from "../../src/pth/impls/kernels/kernel-manager.js";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("任务工作区（fs.task——workspace 收敛——自修改产物落盘）", () => {
  let root: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "taskws-")); await mkdir(join(root, "tasks", "t1"), { recursive: true }); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  function makeKernel() {
    const mgr = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } } as never);
    const toolstore = { readText: async () => "", list: async () => [], listDirs: async () => [] } as never;
    return createWorkerKernelWithManager({
      llm: { complete: async () => ({ ok: false }) } as never,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as never,
      manager: mgr,
      toolstore,
      taskWorkspaceResolve: (rel) => {
        const base = join(root, "tasks", "t1");
        if (rel.startsWith("/") || rel.startsWith("..")) throw new Error("拒绝");
        return join(base, rel);
      },
    });
  }

  it("fs.task.write：写文件到任务工作区（自修改补丁落盘）", async () => {
    const k = makeKernel();
    const r = await k.ts.execute(`await fs.task.write("patch.diff", "--- a/ctx.ts\\n+++ b/ctx.ts\\n+compress"); fs.task.list();`);
    expect(r.ok).toBe(true);
    const list = r.value as Array<{ name: string }>;
    expect(list.some((e) => e.name === "patch.diff")).toBe(true);
    const rd = await k.ts.execute(`await fs.task.read("patch.diff")`);
    expect(rd.value).toContain("compress");
  });

  it("fs.task：拒绝绝对路径/越界", async () => {
    const k = makeKernel();
    // 拒绝路径：write 抛错 → execute ok:false + error 消息
    const r = await k.ts.execute(`await fs.task.write("/etc/passwd", "x")`);
    expect(r.ok).toBe(false);
    expect(r.error?.message ?? "").toContain("拒绝");
    const r2 = await k.ts.execute(`await fs.task.write("../evil", "x")`);
    expect(r2.ok).toBe(false);
    expect(r2.error?.message ?? "").toContain("拒绝");
  });

  it("sandbox bash 与任务工作区协同（同卷同路径——模型写文件 → bash 读取）", async () => {
    const k = makeKernel();
    const w = await k.ts.execute(`await fs.task.write("build.sh", "echo hello-from-task"); "written";`);
    expect(w.ok).toBe(true);
    // 真实文件系统检查（fs.task 写到了 t1 工作区）
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(root, "tasks", "t1", "build.sh"), "utf8");
    expect(content).toBe("echo hello-from-task");
  });
});
