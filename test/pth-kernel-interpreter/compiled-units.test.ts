import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createToolstore } from "../../src/pth/kernel/interpreter/toolstore.js";
import { buildCapabilities } from "../../src/pth/kernel/interpreter/capability.js";

describe("命名编译单元（⑥ B 方案——toolstore 持久化）", () => {
  let dir: string;
  let toolstore: ReturnType<typeof createToolstore>;

  beforeAll(async () => {
    dir = await mkdtemp(tmpdir() + "/cu-");
    toolstore = createToolstore(dir);
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("saveUnit → executeUnit → listUnits 全链路", async () => {
    const executed: string[] = [];
    const fakeC = {
      language: "c",
      execute: async (code: string) => { executed.push(code); return { ok: true, result: "ran", durationMs: 1 }; },
      state: {}, reset() {}, dispose() {},
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
    } as never;
    const caps = buildCapabilities({
      llm: { complete: async () => ({ ok: false, error: "stub" }) } as never,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as never,
      c: fakeC,
      toolstore,
    });
    const c = caps["c"] as {
      saveUnit: (n: string, code: string) => Promise<void>;
      executeUnit: (n: string) => Promise<unknown>;
      listUnits: () => Promise<string[]>;
    };
    // saveUnit
    await c.saveUnit("fib", "int fib(int n){ return n < 2 ? n : fib(n-1) + fib(n-2); }\nint main(){ printf(\"%d\", fib(20)); }");
    // listUnits
    const units = await c.listUnits();
    expect(units).toContain("fib");
    // executeUnit（读源码 → execute——缓存由 CCompiledKernel sha256 处理）
    const r = await c.executeUnit("fib") as { ok: boolean; result: string };
    expect(r.ok).toBe(true);
    expect(executed[0]).toContain("fib(20)");
  });

  it("非法单元名拒绝（路径注入防护）", async () => {
    const caps = buildCapabilities({
      llm: {} as never,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as never,
      c: { execute: async () => ({ ok: true }) } as never,
      toolstore,
    });
    const c = caps["c"] as { saveUnit: (n: string, code: string) => Promise<void> };
    await expect(c.saveUnit("../../etc/passwd", "x")).rejects.toThrow(/非法单元名/);
    await expect(c.saveUnit("a/b", "x")).rejects.toThrow(/非法单元名/);
  });

  it("saveUnit 持久化后 toolstore.readText 可读（跨任务语义）", async () => {
    await toolstore.writeText("compiled-units/direct.c", "int main(){ return 42; }");
    const code = await toolstore.readText("compiled-units/direct.c");
    expect(code).toContain("return 42");
  });
});
