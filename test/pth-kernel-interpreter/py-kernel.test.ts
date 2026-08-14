import { describe, it, expect, afterAll } from "vitest";
import { PyKernel } from "../../src/pth/impls/kernels/py-kernel";

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

describe("PyKernel exec 模式（2026-08-11 元命令拆分——single=eval/program=exec）", () => {
  let k: PyKernel;
  afterAll(async () => { await k?.dispose(); });

  it("single：表达式求值——值直接返回（不再依赖 _result 通道）", async () => {
    k = new PyKernel({ pythonBin: "python3" });
    const r1 = await k.execute("1 + 1", { exec: "single" });
    expect(r1.ok).toBe(true);
    expect(r1.value).toBe(2);
    const r2 = await k.execute("len([1, 2, 3])", { exec: "single" });
    expect(r2.ok).toBe(true);
    expect(r2.value).toBe(3);
    // 对象/列表字面量
    const r3 = await k.execute('{"total": 7}', { exec: "single" });
    expect(r3.ok).toBe(true);
    expect((r3.value as any).total).toBe(7);
  });

  it("single：语句 → 显式语法错误（调用方负责单表达式）", async () => {
    const r = await k.execute("x = 1", { exec: "single" });
    expect(r.ok).toBe(false);
    expect(r.error?.message ?? "").toContain("SyntaxError");
  });

  it("single：不污染命名空间（eval 不写 _LAST_CODE/_result）", async () => {
    const r = await k.execute("40 + 2", { exec: "single" });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
    // 后续 program 模式正常
    const r2 = await k.execute("_result = 99");
    expect(r2.ok).toBe(true);
    expect(r2.value).toBe(99);
  });

  it("program（默认）：exec 语义不变（回归——_result 通道）", async () => {
    const r = await k.execute("_result = [i * i for i in range(3)]", { exec: "program" });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([0, 1, 4]);
  });
});

describe("记忆库注入（2026-08-11 库化——pth-memory-lib）", () => {
  it("memory 全局 seed：query/retrieve/get 方法存在；write 显式只读拒绝", async () => {
    const k = new PyKernel({ pythonBin: "python3" });
    const r = await k.execute("print(type(memory).__name__, hasattr(memory, 'query'), hasattr(memory, 'get'), hasattr(memory, 'retrieve'))");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("Memory True True True");
    const w = await k.execute("memory.write(kind='k', content='c')");
    expect(w.ok).toBe(false);
    const werr = typeof w.error === "string" ? w.error : (w.error as { message?: string })?.message ?? JSON.stringify(w.error);
    expect(werr).toMatch(/只读/);
    k.dispose();
  });

  it("PTH_MEMORY_BRIDGE env 注入：memory.base 反映构造参数", async () => {
    const k = new PyKernel({ pythonBin: "python3", memoryBridge: "http://custom:9999/bridge" });
    const r = await k.execute("print(memory.base)");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("http://custom:9999/bridge");
    k.dispose();
  });

  it("ns reset 保留 memory（库 seed 键——清命名空间不丢桥）", async () => {
    const k = new PyKernel({ pythonBin: "python3" });
    await k.execute("zzz = 1");
    await k.reset();
    const r = await k.execute("print(hasattr(memory, 'query'), 'zzz' in dir())");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("True False");
    k.dispose();
  });
});

describe("审计修复（2026-08-12）", () => {
  it("spawn 失败（ENOENT）快速失败不悬挂（call 同步 throw kernel not writable / timer 兜底 / error 事件三重路径）", async () => {
    const k = new PyKernel({ pythonBin: "/nonexistent/python3", timeoutMs: 3_000 });
    const started = Date.now();
    const r = await k.execute("print(1)");
    expect(r.ok).toBe(false);
    const msg = (r.error as { message: string }).message;
    expect(msg).toMatch(/kernel not writable|timed out|spawn failed/);
    expect(Date.now() - started).toBeLessThan(15_000);   // 不等满默认 300s 超时
    k.dispose();
  });
});

describe("PyKernel——程序级制动（A1 Phase 3 条目 11 abort 契约）", () => {
  it("abort 终止 in-flight 死循环——execute 快落地（不等 timeout）+ 自愈补位", async () => {
    const k = new PyKernel({ pythonBin: "python3" });
    const start = Date.now();
    const p = k.execute("while True: pass", { timeoutMs: 120_000 });
    await new Promise((r) => setTimeout(r, 400));   // 确保进入执行
    await k.abort();
    const r = await p;
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.error?.message ?? "").toContain("aborted");
    expect(elapsed).toBeLessThan(10_000);   // 立即落地而非等 120s timeout
    // 自愈：abort 杀进程后，下个 execute 懒 spawn 冷备补位
    const r2 = await k.execute("_result = 1 + 1");
    expect(r2.ok).toBe(true);
    expect(r2.value).toBe(2);
    k.dispose();
  }, 20_000);

  it("abort 无 in-flight 时安全 no-op（不抛、不破坏后续执行）", async () => {
    const k = new PyKernel({ pythonBin: "python3" });
    await k.abort();
    const r = await k.execute("_result = 6 * 7");
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
    k.dispose();
  }, 20_000);
});
