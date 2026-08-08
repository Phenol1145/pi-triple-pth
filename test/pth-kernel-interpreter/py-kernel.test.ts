import { describe, it, expect, afterAll } from "vitest";
import { PyKernel } from "../../src/pth/kernel/interpreter/py-kernel";

describe("PyKernel（持久管道 REPL）", () => {
  let k: PyKernel;
  afterAll(async () => { await k?.dispose(); });

  it("状态保留：变量跨 cell 存活（持久命名空间）", async () => {
    k = new PyKernel({ pythonBin: "python3" });
    const r1 = await k.execute("x = 10");
    expect(r1.ok).toBe(true);
    const r2 = await k.execute("_result = x * 2");
    expect(r2.ok).toBe(true);
    expect(r2.value).toBe(20);
  });

  it("_result 通道：结构化返回值进 value（非 print 文本）", async () => {
    const r = await k.execute('_result = {"sum": 3, "meta": "computed"}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ sum: 3, meta: "computed" });
  });

  it("未设 _result → value undefined（与 TS return 对齐）", async () => {
    const r = await k.execute("y = 5");
    expect(r.ok).toBe(true);
    expect(r.value).toBeUndefined();
  });

  it("stdout 捕获（print 仍工作）", async () => {
    const r = await k.execute("print('hello from py')");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("hello from py");
  });

  it("错误回传：异常 → ok:false + error.message（进程存活可继续用）", async () => {
    const r1 = await k.execute("raise ValueError('boom')");
    expect(r1.ok).toBe(false);
    expect(r1.error?.message).toContain("ValueError");
    // kernel 未死——继续执行
    const r2 = await k.execute("_result = 42");
    expect(r2.ok).toBe(true);
    expect(r2.value).toBe(42);
  });

  it("语法错误 → ok:false + error", async () => {
    const r = await k.execute("def broken(:" );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBeTruthy();
  });

  it("stdout 截断：maxStdout 超限 → truncated 标记", async () => {
    const r = await k.execute("print('x' * 5000)", { maxStdout: 100 });
    expect(r.ok).toBe(true);
    expect(r.stdout!.length).toBeLessThanOrEqual(100);
    expect(r.truncated?.field).toBe("stdout");
    expect(r.truncated!.originalLen).toBeGreaterThan(100);
  });

  it("reset 清状态：x 消失", async () => {
    await k.execute("x = 99");
    k.reset();
    const r = await k.execute("_result = globals().get('x') is None");
    expect(r.ok).toBe(true);
    expect(r.value).toBe(true);   // x 已不在命名空间
  });

  it("snapshot 导出 globals（可序列化变量 + 函数源码）", async () => {
    await k.execute("import json\nmy_data = {'a': 1}\ndef my_fn(v):\n    return v + 1");
    const snap = await k.snapshot();
    expect(snap).toBeDefined();
    const dataVar = snap.variables.find((v) => v.key === "my_data");
    expect(dataVar).toBeDefined();
    expect(dataVar!.value).toEqual({ a: 1 });
    const fn = snap.functions.find((f) => f.key === "my_fn");
    expect(fn).toBeDefined();
    expect(fn!.source).toContain("def my_fn");
  });

  it("超时 kill：死循环 cell → 超时错误 + 进程重启可用", async () => {
    const r = await k.execute("while True: pass", { timeoutMs: 1500 });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("timed out");
    // 超时后 kernel 被 kill 重启——仍可用
    const r2 = await k.execute("_result = 'alive'");
    expect(r2.ok).toBe(true);
    expect(r2.value).toBe("alive");
  }, 20_000);
});

describe("kernel 参数化（懒 spawn / 空闲回收 / ns reset）", () => {
  it("懒 spawn：构造不 spawn，首次 execute 才起进程", async () => {
    const k = new PyKernel({ pythonBin: "python3", lazySpawn: true });
    // @ts-expect-error 内部字段访问（测试探针）
    expect(k.child).toBeNull();
    const r = await k.execute("_result = 1 + 1");
    expect(r.ok).toBe(true);
    expect(r.value).toBe(2);
    // @ts-expect-error 内部字段访问
    expect(k.child).not.toBeNull();
    await k.reset();
    k.dispose();
  });

  it("ns reset：清命名空间不重启进程（变量不残留）", async () => {
    const k = new PyKernel({ pythonBin: "python3", lazySpawn: true, resetMode: "ns" });
    await k.execute("x_shared = 42");
    await k.reset();
    const r = await k.execute("_result = 'x_shared' in globals()");
    expect(r.value).toBe(false);  // ns 已清
    // @ts-expect-error 内部字段访问
    expect(k.child.exitCode).toBeNull();  // 进程未重启
    k.dispose();
  });
});
