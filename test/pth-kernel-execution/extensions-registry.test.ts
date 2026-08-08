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
  it("注册表：memory/context/model/perf 四成员在位", () => {
    expect(EXTENSIONS.map((e) => e.id)).toEqual(["memory", "context", "model", "perf"]);
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

describe("model 会话切换 + perf 能力面（Phase 3）", () => {
  it("注册表四成员（perf 加入）", () => {
    expect(EXTENSIONS.map((e) => e.id)).toEqual(["memory", "context", "model", "perf"]);
  });

  it("model.set 切换 → agent-loop 选择链生效（modelState 单例闭环）", async () => {
    const { modelState } = await import("../../src/pth/kernel/extensions/model.js");
    const { createKernelManager, createWorkerKernelWithManager } = await import("../../src/pth/kernel/interpreter/kernel-manager.js");
    const manager = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    const kernel = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as any,
      manager, toolstore: null as any,
    });
    // 程序内 model.set 切模型
    const r = await kernel.ts.execute('model.set({ model: \"deepseek-v4-pro\", reason: \"complex-step\" });\nreturn model.get();');
    expect((r.value as any).model).toBe("deepseek-v4-pro");
    // 模块级单例同步（agent-loop 读取同一引用）
    expect(modelState.current?.model).toBe("deepseek-v4-pro");
    expect(modelState.history.length).toBe(1);
    // vm 内再读一致
    const r2 = await kernel.ts.execute("return model.current");
    expect((r2.value as any).model).toBe("deepseek-v4-pro");
    manager.dispose();
    modelState.current = null;
    modelState.history = [];
  });

  it("perf.params/set：运行时调参（配置中心生效）", async () => {
    const { resetConfig } = await import("../../src/pth/kernel/extensions/perf-params.js");
    resetConfig({ PTH_AGENT_MODEL: "m1" });
    const { createKernelManager, createWorkerKernelWithManager } = await import("../../src/pth/kernel/interpreter/kernel-manager.js");
    const manager = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    const kernel = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as any,
      manager, toolstore: null as any,
    });
    const r = await kernel.ts.execute('const before = perf.params(); const s = perf.set({ key: "PTH_AGENT_MODEL", value: "m2" }); const after = perf.params(); return { before: before["PTH_AGENT_MODEL"], setOk: s.ok, after: after["PTH_AGENT_MODEL"] };');
    expect((r.value as any).before).toBe("m1");
    expect((r.value as any).setOk).toBe(true);
    expect((r.value as any).after).toBe("m2");
    // 非 PTH_* 拒绝
    const r2 = await kernel.ts.execute('return perf.set({ key: "HOME", value: "/tmp" })');
    expect((r2.value as any).ok).toBe(false);
    manager.dispose();
  });

  it("perf.publish/apply/list：策略闭环（toolstore 文件）", async () => {
    const { resetConfig } = await import("../../src/pth/kernel/extensions/perf-params.js");
    resetConfig({ PTH_AGENT_MODEL: "m1" });
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const stratDir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-strat-"));
    const { createKernelManager, createWorkerKernelWithManager } = await import("../../src/pth/kernel/interpreter/kernel-manager.js");
    const manager = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    const kernel = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as any,
      manager, toolstore: null as any,
      strategiesDir: stratDir,
    });
    const pub = await kernel.ts.execute('return perf.publish({ id: "fast-agent", params: { PTH_AGENT_MODEL: "deepseek-v4-flash", PTH_BATCH_SCALE_UP_THRESHOLD: "3" } })');
    expect((pub.value as any).ok).toBe(true);
    const app = await kernel.ts.execute('return perf.apply({ id: "fast-agent" })');
    expect((app.value as any).ok).toBe(true);
    expect((app.value as any).appliedParams).toBe(2);
    const check = await kernel.ts.execute('return { model: perf.params()["PTH_AGENT_MODEL"], threshold: perf.params()["PTH_BATCH_SCALE_UP_THRESHOLD"] }');
    expect((check.value as any).model).toBe("deepseek-v4-flash");
    expect((check.value as any).threshold).toBe("3");
    const list = await kernel.ts.execute('return perf.list()');
    expect((list.value as any).length).toBe(1);
    const analyze = await kernel.ts.execute('return perf.analyze()');
    expect((analyze.value as any).notes.length).toBeGreaterThan(0);
    manager.dispose();
    fs.rmSync(stratDir, { recursive: true, force: true });
  });
});
