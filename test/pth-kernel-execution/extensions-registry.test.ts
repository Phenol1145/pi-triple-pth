import { describe, it, expect } from "vitest";
import { EXTENSIONS, buildExtensions, buildSeeds, buildDoc } from "../../src/pth/kernel/extensions/index.js";

/**
 * 标准扩展包注册机制（Phase 1——memory/context/model 迁入整理）。
 */

const mockDataWorld = {
  memory: { retrieve: async () => [], write: async () => {} },
  tasks: { candidates: async () => [], submit: async () => {} },
  queryReadOnly: async () => [],
} as any;

describe("ts REPL 标准扩展包", () => {
  it("注册表：memory/context/model 三成员在位", () => {
    expect(EXTENSIONS.map((e) => e.id)).toEqual(["memory", "context", "model"]);
  });

  it("buildExtensions：能力注入（memory.query 受限 SQL）+ 预置对象（context/results/model）", () => {
    const { capabilities, seeds } = buildExtensions({ dataWorld: mockDataWorld });
    // provide：memory 含 query + 封装方法
    expect(capabilities["memory"]).toBeDefined();
    expect((capabilities["memory"] as any).query).toBeTypeOf("function");
    expect((capabilities["memory"] as any).retrieve).toBeTypeOf("function");
    // seed：context/results/model 对象
    expect(seeds["context"]).toEqual({});
    expect(seeds["results"]).toEqual({});
    expect((seeds["model"] as any).current).toBeNull();
    expect((seeds["model"] as any).history).toEqual([]);
  });

  it("buildSeeds：不执行 provide（ts-interpreter 构造安全）", () => {
    const seeds = buildSeeds();
    expect(seeds["context"]).toBeDefined();
    expect(seeds["results"]).toBeDefined();
    expect(seeds["model"]).toBeDefined();
  });

  it("buildDoc：文档自动聚合（LLM 能力文档数据源）", () => {
    const doc = buildDoc();
    expect(doc).toContain("memory.query");
    expect(doc).toContain("memory_entries");
    expect(doc).toContain("results");
    expect(doc).toContain("context");
    expect(doc).toContain("model");
  });

  it("AGENT_CAPABILITY_DOC 与扩展包 doc 一致（聚合生效）", async () => {
    const { AGENT_CAPABILITY_DOC } = await import("../../src/pth/kernel/execution/agent-tools.js");
    expect(AGENT_CAPABILITY_DOC).toContain(buildDoc().slice(0, 50));
    expect(AGENT_CAPABILITY_DOC).toContain("model");
  });

  it("ts 核预置：model 对象在 vm 内可见（seed 生效）", async () => {
    const { createKernelManager, createWorkerKernelWithManager } = await import("../../src/pth/kernel/interpreter/kernel-manager.js");
    const manager = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    const kernel = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as any,
      manager,
      toolstore: null as any,
    });
    const r = await kernel.ts.execute("return { hasModel: typeof model === 'object', hasCtx: typeof context === 'object', hasResults: typeof results === 'object' }");
    expect(r.ok).toBe(true);
    expect((r.value as any).hasModel).toBe(true);
    expect((r.value as any).hasCtx).toBe(true);
    expect((r.value as any).hasResults).toBe(true);
    manager.dispose();
  });
});
