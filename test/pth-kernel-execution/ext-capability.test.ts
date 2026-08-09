import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolstore } from "../../src/pth/kernel/interpreter/toolstore.js";
import { scanExtensions, createExtCapability } from "../../src/pth/kernel/interpreter/ext-capability.js";
import { createWorkerKernelWithManager } from "../../src/pth/kernel/interpreter/kernel-manager.js";

/** 代码库式扩展（hello-world——复用 toolstore/extensions/hello-world 真实示例） */
describe("扩展编排面（代码库式——ext 能力 + 公共记忆区索引）", () => {
  let dir: string;
  let toolstore: ReturnType<typeof createToolstore>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ext-cap-"));
    toolstore = createToolstore(dir);
    // 复制示例扩展到临时 toolstore
    await mkdir(join(dir, "extensions", "hello-world"), { recursive: true });
    await writeFile(join(dir, "extensions", "hello-world", "plugin.json"),
      await import("node:fs/promises").then(({ readFile }) => readFile("toolstore/extensions/hello-world/plugin.json", "utf8")));
    await writeFile(join(dir, "extensions", "hello-world", "index.ts"),
      await import("node:fs/promises").then(({ readFile }) => readFile("toolstore/extensions/hello-world/index.ts", "utf8")));
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("ext.index：扫描扩展清单（manifest 元数据——不装载不注册）", async () => {
    const entries = await scanExtensions(toolstore);
    expect(entries.length).toBe(1);
    expect(entries[0]!.id).toBe("hello-world");
    expect(entries[0]!.contracts).toContain("tool:greet");
    expect(entries[0]!.contracts.some((c) => c.startsWith("role:"))).toBe(true);
  });

  it("ext.use：按需引用扩展代码（eval 重放——无注册）", async () => {
    const ext = createExtCapability({ toolstore });
    const r = await (ext["ext"] as { use: (n: string, a?: unknown) => Promise<unknown> }).use("hello-world", { tool: "greet", args: { name: "PTH" } });
    expect(r).toMatchObject({ ok: true, result: "Hello, PTH!" });
  });

  it("ext.use：缺省工具取第一个", async () => {
    const ext = createExtCapability({ toolstore });
    const r = await (ext["ext"] as { use: (n: string) => Promise<unknown> }).use("hello-world");
    expect(r).toMatchObject({ result: "Hello, world!" });
  });

  it("ext.use：目标工具不存在 → 明确错误", async () => {
    const ext = createExtCapability({ toolstore });
    await expect(
      (ext["ext"] as { use: (n: string, a?: unknown) => Promise<unknown> }).use("hello-world", { tool: "nope" }),
    ).rejects.toThrow(/无工具/);
  });

  it("ext.syncIndex：写入公共记忆区（kind:extension-index——agent 可查询发现）", async () => {
    const writes: Array<{ kind: string; anchors: string[] }> = [];
    const memory = { write: async (e: { kind: string; anchors: string[]; content: string }) => { writes.push(e); } };
    const ext = createExtCapability({ toolstore, memory: memory as never });
    const r = await (ext["ext"] as { syncIndex: () => Promise<{ count: number }> }).syncIndex();
    expect(r).toEqual({ count: 1 });
    expect(writes[0]!.kind).toBe("extension-index");
    expect(writes[0]!.anchors).toContain("extensions");
    expect(writes[0]!.content).toContain("hello-world");
  });

  it("ts 程序能力面：buildCapabilities 注入 ext（代码库式——无注册式 contracts）", () => {
    const k = createWorkerKernelWithManager({
      llm: { complete: async () => ({ ok: false }) } as never,
      dataWorld: {
        memory: { retrieve: async () => [], write: async () => {} },
        tasks: { candidates: async () => [], submit: async () => {} },
        queryReadOnly: async () => [],
      } as never,
      manager: {
        bash: { language: "bash", execute: async () => ({ ok: true }), state: {}, reset() {}, dispose() {}, snapshot: async () => ({ variables: [], functions: [], oversized: [] }) },
        python: { language: "python", execute: async () => ({ ok: true }), state: {}, reset() {}, dispose() {}, snapshot: async () => ({ variables: [], functions: [], oversized: [] }) },
        c: { language: "c", execute: async () => ({ ok: true }), state: {}, reset() {}, dispose() {}, snapshot: async () => ({ variables: [], functions: [], oversized: [] }) },
      } as never,
      toolstore,
    });
    expect(k.capabilities["ext"]).toBeDefined();
    const ext = k.capabilities["ext"] as Record<string, unknown>;
    expect(typeof ext["index"]).toBe("function");
    expect(typeof ext["use"]).toBe("function");
    expect(typeof ext["syncIndex"]).toBe("function");
  });
});

describe("ext.kernel 接线（新执行核——代码库式）", () => {
  it("注册新执行核 → kernel-manager execute(language) 路由扩展 → ts 程序可用", async () => {
    const { createKernelManager } = await import("../../src/pth/kernel/interpreter/kernel-manager.js");
    const mgr = createKernelManager({
      pythonMode: "kernel", bashMode: "kernel",
      kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" },
    } as never);
    // 注册一个"ro"（只读 mock）内核——Interpreter 接口
    mgr.registerKernel("ro", {
      language: "ro",
      state: {},
      execute: async (program: string) => ({ ok: true, result: `ro:${program}`, durationMs: 1, language: "ro" }),
      reset() {}, dispose() {},
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
    } as never);
    const r = await mgr.execute("ro", "hello");
    expect(r).toMatchObject({ ok: true, result: "ro:hello" });
    // 内置语言不可覆盖
    expect(() => mgr.registerKernel("python", {} as never)).toThrow(/不可覆盖/);
  });

  it("ext.kernel：eval 扩展代码 → 注册 → ts 程序内 rust.execute 可用（能力面）", async () => {
    const { createWorkerKernelWithManager, createKernelManager } = await import("../../src/pth/kernel/interpreter/kernel-manager.js");
    const mgr = createKernelManager({
      pythonMode: "kernel", bashMode: "kernel",
      kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" },
    } as never);
    const k = createWorkerKernelWithManager({
      llm: { complete: async () => ({ ok: false }) } as never,
      dataWorld: {
        memory: { retrieve: async () => [], write: async () => {} },
        tasks: { candidates: async () => [], submit: async () => {} },
        queryReadOnly: async () => [],
      } as never,
      manager: mgr,
      registerKernel: (language, interpreter) => mgr.registerKernel(language, interpreter as never),
    });
    const ext = k.capabilities["ext"] as { kernel: (lang: string, code: string) => Promise<{ ok: boolean }> };
    // 扩展代码（代码库式——module.exports 导出 create）
    const extCode = `
      module.exports = {
        create: () => ({
          language: "rust",
          state: {},
          execute: async (code) => ({ ok: true, result: "rust-compiled:" + code.slice(0, 10), durationMs: 1, language: "rust" }),
          reset() {}, dispose() {},
          snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
        }),
      };`;
    const reg = await ext.kernel("rust", extCode);
    expect(reg).toEqual({ language: "rust", ok: true });
    // manager 路由可用
    const r = await mgr.execute("rust", "fn main(){}");
    expect(r).toMatchObject({ ok: true, result: "rust-compiled:fn main(){" });
  });

  it("ext.kernel：代码未导出 execute → 明确错误", async () => {
    const { createWorkerKernelWithManager, createKernelManager } = await import("../../src/pth/kernel/interpreter/kernel-manager.js");
    const mgr = createKernelManager({
      pythonMode: "kernel", bashMode: "kernel",
      kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" },
    } as never);
    const k = createWorkerKernelWithManager({
      llm: {} as never,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as never,
      manager: mgr,
      registerKernel: (language, interpreter) => mgr.registerKernel(language, interpreter as never),
    });
    const ext = k.capabilities["ext"] as { kernel: (lang: string, code: string) => Promise<unknown> };
    await expect(ext.kernel("bad", "module.exports = { notKernel: 1 };")).rejects.toThrow(/execute/);
  });
});
