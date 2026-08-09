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
