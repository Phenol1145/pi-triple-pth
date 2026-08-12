import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolstore } from "../../src/pth/kernel/interpreter/toolstore.js";
import { scanExtensions, createExtCapability } from "../../src/pth/kernel/interpreter/ext-capability.js";
import { createWorkerKernelWithManager } from "../../src/pth/impls/kernels/kernel-manager.js";

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
  let dir: string;
  let toolstore: ReturnType<typeof createToolstore>;
  const RUST_EXT = `
      module.exports = {
        create: () => ({
          language: "rust",
          state: {},
          execute: async (code) => ({ ok: true, result: "rust-compiled:" + code.slice(0, 10), durationMs: 1, language: "rust" }),
          reset() {}, dispose() {},
          snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
        }),
      };`;
  const RUST_EXT2 = `
      module.exports = {
        create: () => ({
          language: "rust",
          state: {},
          execute: async (code) => ({ ok: true, result: "rust:" + code.trim(), durationMs: 1, language: "rust" }),
          reset() {}, dispose() {},
          snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
        }),
      };`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ext-kernel-"));
    toolstore = createToolstore(dir);
    await mkdir(join(dir, "extensions", "rust"), { recursive: true });
    await writeFile(join(dir, "extensions", "rust", "index.ts"), RUST_EXT);
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("注册新执行核 → kernel-manager execute(language) 路由扩展 → ts 程序可用", async () => {
    const { createKernelManager } = await import("../../src/pth/impls/kernels/kernel-manager.js");
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

  it("ext.kernel：引用 toolstore 扩展（index.ts eval 重放）→ 注册 → ts 程序内 rust.execute 可用（能力面）", async () => {
    const { createWorkerKernelWithManager, createKernelManager } = await import("../../src/pth/impls/kernels/kernel-manager.js");
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
      toolstore,
    });
    const ext = k.capabilities["ext"] as { kernel: (name: string, code?: string) => Promise<{ ok: boolean }> };
    // 仅按名字引用 toolstore 扩展（管理员放置）——不传内联代码
    const reg = await ext.kernel("rust");
    expect(reg).toEqual({ language: "rust", ok: true });
    // manager 路由可用
    const r = await mgr.execute("rust", "fn main(){}");
    expect(r).toMatchObject({ ok: true, result: "rust-compiled:fn main(){" });
  });

  it("ext.kernel：拒绝任务内联代码（RCE 防护——code 参数一律拒绝，必须走 toolstore）", async () => {
    const { createWorkerKernelWithManager, createKernelManager } = await import("../../src/pth/impls/kernels/kernel-manager.js");
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
      toolstore,
    });
    const ext = k.capabilities["ext"] as { kernel: (name: string, code?: string) => Promise<unknown> };
    // 任务代码试图传入任意内联代码（旧 RCE 路径）→ 必须拒绝
    await expect(ext.kernel("evil", "module.exports = { create: () => ({ execute: async () => process.exit(1) }) };")).rejects.toThrow(/内联代码|toolstore/);
    // 未放置的扩展名 → 读取失败（不得 eval 任何任务输入）
    await expect(ext.kernel("evil")).rejects.toThrow();
  });

  it("ext.kernel 后注册 → 同一 ts 程序内 rust.execute 可用（动态注入 vm context）", async () => {
    const { createWorkerKernelWithManager, createKernelManager } = await import("../../src/pth/impls/kernels/kernel-manager.js");
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
      toolstore,
    });
    const ext = k.capabilities["ext"] as { kernel: (name: string) => Promise<{ ok: boolean }> };
    await ext.kernel("rust");
    // 同一 worker ts 程序（同一 context——模拟任务代码后续 cell）调用 rust.execute
    // （顶层 await 写法——与生产任务程序一致；async IIFE 是 wrapAwait 已知边缘坑）
    const r = await k.ts.execute(`(await rust.execute("hi")).result`);
    expect(r.ok).toBe(true);
    expect(r.value).toBe("rust-compiled:hi");
  });

  it("ext.kernel：toolstore 扩展代码未导出 execute → 明确错误", async () => {
    const { createWorkerKernelWithManager, createKernelManager } = await import("../../src/pth/impls/kernels/kernel-manager.js");
    const mgr = createKernelManager({
      pythonMode: "kernel", bashMode: "kernel",
      kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" },
    } as never);
    const k = createWorkerKernelWithManager({
      llm: {} as never,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as never,
      manager: mgr,
      registerKernel: (language, interpreter) => mgr.registerKernel(language, interpreter as never),
      toolstore,
    });
    const ext = k.capabilities["ext"] as { kernel: (name: string) => Promise<unknown> };
    // 未放置扩展 → 读取即失败（toolstore 内无 bad 扩展）
    await expect(ext.kernel("bad")).rejects.toThrow();
  });
});

describe("扩展编排面——SDK 完善（2026-08-12：index.js 入口 + 标准通道注入）", () => {
  let dir: string;
  let toolstore: ReturnType<typeof createToolstore>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ext-cap2-"));
    toolstore = createToolstore(dir);
    await mkdir(join(dir, "extensions", "js-ext"), { recursive: true });
    await writeFile(join(dir, "extensions", "js-ext", "plugin.json"), JSON.stringify({ id: "js-ext", name: "JS Ext", contracts: { tools: ["js.tool"] }, activation: { onStartup: true }, compat: { pluginApi: ">=0.6.0" } }));
    await writeFile(join(dir, "extensions", "js-ext", "index.js"),
      `module.exports = async function factory(ctx) {
        return { tools: {
          "js.tool": async (args) => {
            if (ctx.exec) { const r = await ctx.exec("node", ["-e", "console.log('ok')"]); return { ok: r.ok, result: r.stdout }; }
            return { ok: false, error: "no exec channel" };
          },
        } };
      };`);
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("scanExtensions：index.js 入口识别（entry 指向 index.js）", async () => {
    const entries = await scanExtensions(toolstore);
    expect(entries.length).toBe(1);
    expect(entries[0]!.entry).toBe("extensions/js-ext/index.js");
  });

  it("ext.use：index.js 入口 + ctx.exec 标准通道注入（不再裸 import child_process）", async () => {
    const dbQuery = async (t: string, s: string) => [{ table: t }];
    const ext = createExtCapability({ toolstore, dbQuery });
    const r = await (ext["ext"] as { use: (n: string, a?: unknown) => Promise<{ ok: boolean; result?: string; error?: string }> }).use("js-ext", { tool: "js.tool" });
    expect(r.ok).toBe(true);
    expect(r.result).toContain("ok");
  });

  it("ext.use：ctx.db 通道（表白名单 + where 过滤——通道层保证）", async () => {
    const seen: string[] = [];
    const dbQuery = async (t: string, s: string) => { seen.push(s); return [{ id: "x" }]; };
    const ext = createExtCapability({ toolstore, dbQuery });
    // 用 sql-readonly 同构扩展验证通道（js-ext 内直接调 ctx.db）
    await mkdir(join(dir, "extensions", "db-ext"), { recursive: true });
    await writeFile(join(dir, "extensions", "db-ext", "plugin.json"), JSON.stringify({ id: "db-ext", name: "DB Ext", contracts: { tools: ["db.q"] }, activation: { onStartup: true }, compat: { pluginApi: ">=0.6.0" } }));
    await writeFile(join(dir, "extensions", "db-ext", "index.js"),
      `module.exports = async function factory(ctx) {
        return { tools: { "db.q": async (args) => ctx.db ? await ctx.db.query(String(args.table), { where: { status: "pending" }, limit: 3 }) : { ok: false, error: "no db" } } };
      };`);
    const r = await (ext["ext"] as { use: (n: string, a?: unknown) => Promise<{ ok: boolean; rows?: unknown; error?: string }> }).use("db-ext", { tool: "db.q", args: { table: "tasks" } });
    expect(r.ok).toBe(true);
    expect(seen[0]).toContain("FROM tasks");
    expect(seen[0]).toContain("status = 'pending'");
    // 白名单拒绝（表不在白名单）
    const bad = await (ext["ext"] as { use: (n: string, a?: unknown) => Promise<{ ok: boolean; error?: string }> }).use("db-ext", { tool: "db.q", args: { table: "users" } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("白名单");
  });
});
