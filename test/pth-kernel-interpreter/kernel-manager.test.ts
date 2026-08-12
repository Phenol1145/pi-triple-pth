import { describe, it, expect, afterAll } from "vitest";
import { createKernelManager, createWorkerKernelWithManager } from "../../src/pth/impls/kernels/kernel-manager";
import type { LlmFn } from "../../src/pth/kernel/interpreter/llm-fn";

describe("KernelManager（多语言路由）", () => {
  let mgr: ReturnType<typeof createKernelManager>;
  afterAll(() => mgr?.dispose());

  it("统一 execute 路由三语言", async () => {
    mgr = createKernelManager({ pythonMode: "kernel", bashMode: "kernel" });
    const ts = await mgr.execute("ts", "1 + 1");
    expect(ts.ok).toBe(true);
    expect(ts.value).toBe(2);
    const py = await mgr.execute("python", "_result = 2 * 3");
    expect(py.ok).toBe(true);
    expect(py.value).toBe(6);
    const bash = await mgr.execute("bash", "echo routed");
    expect(bash.ok).toBe(true);
    expect(bash.stdout).toContain("routed");
  });

  it("未知语言 → ok:false", async () => {
    const r = await mgr.execute("ruby", "puts 1");
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("unknown language");
  });

  it("interpreter 模式（每次 spawn 的 python + sandbox bash）", async () => {
    const m2 = createKernelManager({ pythonMode: "interpreter", bashMode: "interpreter" });
    // interpreter 模式无 _result 通道（只捕获 stdout）——用 print
    const py = await m2.execute("python", "print(4 + 4)");
    expect(py.ok).toBe(true);
    expect(py.stdout).toContain("8");
    m2.dispose();
  });

  it("持久状态跨 execute（manager 级）", async () => {
    await mgr.execute("python", "counter = 0");
    await mgr.execute("python", "counter += 5");
    const r = await mgr.execute("python", "_result = counter");
    expect(r.value).toBe(5);
  });

  it("reset 清所有 kernel 状态", async () => {
    await mgr.execute("python", "x = 99");
    await mgr.execute("bash", "cd /tmp");
    mgr.reset();
    const py = await mgr.execute("python", "_result = 'x' in globals()");
    expect(py.value).toBe(false);
    const bash = await mgr.execute("bash", "pwd");
    expect(bash.stdout.trim()).not.toBe("/tmp");
  });
});

describe("createWorkerKernelWithManager（与 worker 集成）", () => {
  it("能力注入 + 任务代码三语言协作", async () => {
    const mgr = createKernelManager({ pythonMode: "kernel", bashMode: "kernel" });
    const llm: LlmFn = { complete: async () => ({ content: "mock", model: "mock" }) };
    const dataWorld = {
      tasks: {
        candidates: async () => [],
        submit: async () => {},
      },
      memory: {
        write: async () => {}, retrieve: async () => [], bumpHitCount: async () => {},
      },
      transcripts: {}, audit: {},
    queryReadOnly: async () => [],
    } as any;
    const wk = createWorkerKernelWithManager({ llm, dataWorld, manager: mgr });

    // 任务代码：python 计算 + bash 取数 + ts 逻辑
    const code = [
      `const py = await python.execute("_result = [i*i for i in range(5)]");`,
      `const b = await bash.execute("echo done");`,
      `const total = py.value.reduce((a, c) => a + c, 0);`,
      `return { total, bashOut: b.stdout.trim(), language: "ts" };`,
    ].join("\n");
    const r = await wk.ts.execute(code);
    expect(r.ok).toBe(true);
    const v = r.value as { total: number; bashOut: string };
    expect(v.total).toBe(30);   // 0+1+4+9+16
    expect(v.bashOut).toBe("done");
    wk.dispose();
  });
});
