import { describe, it, expect } from "vitest";
import { TsInterpreter } from "../../src/pth/kernel/interpreter/ts-interpreter";

describe("ts interpreter", () => {
  it("executes simple expression and returns value", async () => {
    const itp = new TsInterpreter({ capabilities: {} });
    const res = await itp.execute("1 + 1");
    expect(res.ok).toBe(true);
    expect(res.value).toBe(2);
  });

  it("preserves state across executions (persistent context)", async () => {
    const itp = new TsInterpreter({ capabilities: {} });
    await itp.execute("let counter = 0");
    await itp.execute("counter = counter + 1");
    const res = await itp.execute("counter");
    expect(res.value).toBe(1);
  });

  it("supports async/await via top-level await wrapping", async () => {
    const itp = new TsInterpreter({ capabilities: {} });
    const res = await itp.execute("await Promise.resolve(42)");
    expect(res.ok).toBe(true);
    expect(res.value).toBe(42);
  });

  it("supports top-level return without await（回归：无 await 的 return 任务）", async () => {
    const itp = new TsInterpreter({ capabilities: {} });
    const res = await itp.execute("function fib(n){return n<=1?n:fib(n-1)+fib(n-2)}; return { fib10: fib(10) };");
    expect(res.ok).toBe(true);
    expect((res.value as { fib10: number }).fib10).toBe(55);
  });

  it("rejects import statements with friendly error", async () => {
    const itp = new TsInterpreter({ capabilities: {} });
    const res = await itp.execute("import { x } from 'y'; x");
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("import");
  });

  it("rejects require calls with friendly error", async () => {
    const itp = new TsInterpreter({ capabilities: {} });
    const res = await itp.execute("const x = require('y'); x");
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("require");
  });

  it("runs TypeScript with type annotations (strip types)", async () => {
    const itp = new TsInterpreter({ capabilities: {} });
    const res = await itp.execute("const add = (a: number, b: number): number => a + b; add(2, 3)");
    expect(res.ok).toBe(true);
    expect(res.value).toBe(5);
  });

  it("enforces timeout", async () => {
    const itp = new TsInterpreter({ capabilities: {}, timeoutMs: 100 });
    const res = await itp.execute("while(true) {}", { timeoutMs: 100 });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("Script execution timed out");
  });

  it("reset clears state but keeps capabilities", async () => {
    const itp = new TsInterpreter({ capabilities: { marker: "keep" } });
    await itp.execute("let x = 1");
    itp.reset();
    const res = await itp.execute("typeof x");   // x 已清空
    expect(res.value).toBe("undefined");
    // capabilities 保留
    const capRes = await itp.execute("marker");
    expect(capRes.value).toBe("keep");
  });

  it("exposes injected capabilities", async () => {
    const itp = new TsInterpreter({ capabilities: { llm: { complete: async () => ({ content: "ok" }) } } });
    const res = await itp.execute("llm.complete()");
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({ content: "ok" });
  });

  it("does not hang forever on never-resolving async code (async timeout guard)", async () => {
    // Finding #1: runInContext timeout 只覆盖同步执行；await 后的异步延续不受限。
    // `await new Promise(() => {})` 永不 resolve——execute 必须在 ~timeoutMs 内返回失败而非无限挂起。
    const itp = new TsInterpreter({ capabilities: {}, timeoutMs: 50 });
    const start = Date.now();
    const res = await itp.execute("await new Promise(() => {})", { timeoutMs: 50 });
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("timed out after 50ms");
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(5000); // 不无限挂起（vitest testTimeout 90s 兜底）
  });

  it("captures value of single-expression await with trailing semicolon", async () => {
    // Finding #2: 尾分号 `await Promise.resolve(42);` 不应被误判为多语句 → 块包装丢值。
    const itp = new TsInterpreter({ capabilities: {} });
    const res = await itp.execute("await Promise.resolve(42);");
    expect(res.ok).toBe(true);
    expect(res.value).toBe(42);
  });

  it("duplicate const declaration across executions fails (persistent context semantics)", async () => {
    // Finding #3（设计级限制，不修代码，固化行为）：vm 持久 context 的全局词法绑定无法重声明。
    // 需要重新声明应调用 reset()（或换 interpreter）。
    const itp = new TsInterpreter({ capabilities: {} });
    const first = await itp.execute("const s = 1");
    expect(first.ok).toBe(true);
    const second = await itp.execute("const s = 1");
    expect(second.ok).toBe(false);
    expect(second.error?.message).toContain("already been declared");
  });
});
