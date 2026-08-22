import { describe, it, expect } from "vitest";
import { EXTENSIONS, buildExtensions, buildSeeds, buildDoc } from "@away_from/pth-kernel-interpreter";

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
    expect(EXTENSIONS.map((e) => e.id)).toEqual(["memory", "context", "model", "perf", "obs", "manage"]);
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
    const { AGENT_CAPABILITY_DOC } = await import("@away_from/pth-kernel-execution");
    expect(AGENT_CAPABILITY_DOC).toContain(buildDoc().slice(0, 50));
    expect(AGENT_CAPABILITY_DOC).toContain("model");
  });

  it("ts 核预置：model 对象在 vm 内可见（seed 生效）", async () => {
    const { createKernelManager, createWorkerKernelWithManager } = await import("../../src/pth/impls/kernels/kernel-manager.js");
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
    expect(EXTENSIONS.map((e) => e.id)).toEqual(["memory", "context", "model", "perf", "obs", "manage"]);
  });

  it("model 管理面裁剪（权限 v2 R3）：worker 面只读（set 摘除，get/usage 保留）", async () => {
    const { modelState } = await import("@away_from/pth-kernel-interpreter");
    const { createKernelManager, createWorkerKernelWithManager } = await import("../../src/pth/impls/kernels/kernel-manager.js");
    const manager = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    const kernel = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as any,
      manager, toolstore: null as any,
    });
    // model.set 不在 worker 注入面（管理面写操作——防 worker 切模型）
    const r = await kernel.ts.execute('return { hasSet: typeof model.set, hasGet: typeof model.get, hasUsage: typeof model.usage }');
    expect((r.value as any).hasSet).toBe("undefined");
    expect((r.value as any).hasGet).toBe("function");
    expect((r.value as any).hasUsage).toBe("object");
    // modelState 单例仍可由系统侧（agent-loop）直读直写——不经能力注入
    modelState.set({ model: "deepseek-v4-pro", reason: "system" });
    const r2 = await kernel.ts.execute("return model.get()");
    expect((r2.value as any).model).toBe("deepseek-v4-pro");   // worker 只读可见系统切换结果
    manager.dispose();
    modelState.current = null;
    modelState.history = [];
  });

  it("perf 管理面裁剪（权限 v2 R3）：worker 面只读（params 可读，set 摘除）", async () => {
    const { resetConfig } = await import("@away_from/pth-kernel-interpreter");
    resetConfig({ PTH_AGENT_MODEL: "m1" });
    const { createKernelManager, createWorkerKernelWithManager } = await import("../../src/pth/impls/kernels/kernel-manager.js");
    const manager = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    const kernel = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as any,
      manager, toolstore: null as any,
    });
    const r = await kernel.ts.execute('return { model: perf.params()["PTH_AGENT_MODEL"], hasSet: typeof perf.set, hasPublish: typeof perf.publish, hasApply: typeof perf.apply, hasList: typeof perf.list, hasAnalyze: typeof perf.analyze }');
    expect((r.value as any).model).toBe("m1");                    // 只读 params 可用
    expect((r.value as any).hasSet).toBe("undefined");            // 管理面写操作摘除
    expect((r.value as any).hasPublish).toBe("undefined");
    expect((r.value as any).hasApply).toBe("undefined");
    expect((r.value as any).hasList).toBe("function");            // 只读子集保留
    expect((r.value as any).hasAnalyze).toBe("function");
    manager.dispose();
  });

  it("perf 全量面（set/publish/apply）仍在扩展层——系统通道用（不经 worker 注入）", async () => {
    const { resetConfig } = await import("@away_from/pth-kernel-interpreter");
    resetConfig({ PTH_AGENT_MODEL: "m1" });
    const { perfExtension } = await import("@away_from/pth-kernel-interpreter");
    const caps = perfExtension.provide({ dataWorld: {} } as never) as { perf: Record<string, Function> };
    const s = caps.perf["set"]({ key: "PTH_AGENT_MODEL", value: "m2" });
    expect((s as any).ok).toBe(true);
    expect(typeof caps.perf["publish"]).toBe("function");
    expect(typeof caps.perf["apply"]).toBe("function");
    const denied = caps.perf["set"]({ key: "HOME", value: "/tmp" });
    expect((denied as any).ok).toBe(false);   // 非 PTH_* 拒绝（扩展层规则不变）
  });

  it("perf.publish/apply/list：策略闭环（扩展层——权限 v2 后不经 worker kernel）", async () => {
    const { resetConfig } = await import("@away_from/pth-kernel-interpreter");
    resetConfig({ PTH_AGENT_MODEL: "m1" });
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const stratDir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-strat-"));
    const { perfExtension } = await import("@away_from/pth-kernel-interpreter");
    const perf = (perfExtension.provide({ dataWorld: {}, strategiesDir: stratDir } as never) as { perf: Record<string, Function> }).perf;
    const pub = await perf["publish"]({ id: "fast-agent", params: { PTH_AGENT_MODEL: "deepseek-v4-flash", PTH_BATCH_SCALE_UP_THRESHOLD: "3" } }) as any;
    expect(pub.ok).toBe(true);
    const app = await perf["apply"]({ id: "fast-agent" }) as any;
    expect(app.ok).toBe(true);
    expect(app.appliedParams).toBe(2);
    const list = await perf["list"]() as any;
    expect(list.length).toBe(1);
    const analyze = await perf["analyze"]() as any;
    expect(analyze.notes.length).toBeGreaterThan(0);
    fs.rmSync(stratDir, { recursive: true, force: true });
  });

  it("perf.apply：actions 经统一模板解析器投递（成功发布 + 单条失败隔离）", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const stratDir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-strat-actions-"));
    const { perfExtension } = await import("@away_from/pth-kernel-interpreter");
    const published: Array<{ title: string; text: string; createdBy: string; tags?: string[]; payload?: Record<string, unknown> }> = [];
    const dataWorld = {
      tasks: {
        publish: async (input: { title: string; text: string; createdBy: string; tags?: string[]; payload?: Record<string, unknown> }) => {
          published.push(input);
          return { id: `task-${published.length}` };
        },
      },
    };
    const perf = (perfExtension.provide({ dataWorld, strategiesDir: stratDir } as never) as { perf: Record<string, Function> }).perf;
    await perf["publish"]({
      id: "s-actions",
      params: { PTH_AGENT_MODEL: "m2" },
      actions: [
        { type: "task", template: "recon-doc", params: { url: "https://x.dev/a" } },
        { type: "task", template: "nope" },
      ],
    });
    const app = await perf["apply"]({ id: "s-actions" }) as any;
    expect(app.ok).toBe(true);
    expect(app.appliedParams).toBe(1);
    expect(app.actions).toBe(2);
    expect(app.dispatched).toHaveLength(1);
    expect(app.dispatchErrors).toHaveLength(1);
    expect(app.dispatchErrors[0]).toContain("unknown template");
    expect(published).toHaveLength(1);
    expect(published[0]!.title).toContain("recon-doc");
    expect(published[0]!.tags).toEqual(["recon"]);
    expect(published[0]!.createdBy).toBe("perf-strategy:s-actions");
    expect(published[0]!.payload).toMatchObject({ template: "recon-doc", perfStrategy: "s-actions" });
    fs.rmSync(stratDir, { recursive: true, force: true });
  });
});

describe("obs 可监控数据调查（Phase 4）", () => {
  it("注册表六成员（manage 加入——2026-08-12 管理 SDK）", () => {
    expect(EXTENSIONS.map((e) => e.id)).toEqual(["memory", "context", "model", "perf", "obs", "manage"]);
  });

  it("obs.tasks：任务池状态分布（pg 封装 SQL——mock dataWorld）", async () => {
    const seen: string[] = [];
    const dw = {
      memory: { retrieve: async () => [], write: async () => {} },
      tasks: { candidates: async () => [], submit: async () => {} },
      // A2 Phase 4：obs 工具走 queryTemplate 受信模板通道（queryReadOnly 为 memory-only LLM 面）
      queryTemplate: async (sql: string) => {
        seen.push(sql);
        return [{ status: "completed", n: "5" }];
      },
    } as any;
    const { obsExtension } = await import("@away_from/pth-kernel-interpreter");
    const obs = obsExtension.provide!({ dataWorld: dw } as any)["obs"] as any;
    const r = await obs.tasks({ status: "completed", role: "developer", limit: 10 });
    expect(r).toEqual([{ status: "completed", n: "5" }]);
    expect(seen[0]).toContain("WHERE");
    expect(seen[0]).toContain("status = 'completed'");
    expect(seen[0]).toContain("LIMIT 10");
    // 非法 status（注入防护）→ 条件被忽略
    await obs.tasks({ status: "x'; DROP TABLE tasks; --" });
    expect(seen[1]).not.toContain("DROP");
  });

  it("obs.kernels：sandbox URL 未配置 → 明确错误", async () => {
    delete process.env.PTH_SANDBOX_KERNEL_URL;
    delete process.env.SANDBOX_URL;
    const { obsExtension } = await import("@away_from/pth-kernel-interpreter");
    const obs = obsExtension.provide!({ dataWorld: { queryReadOnly: async () => [] } as any } as any)["obs"] as any;
    const r = await obs.kernels();
    expect(r.error).toContain("未配置");
  });

  it("obs.search：SQL 注入转义（单引号翻倍）", async () => {
    const seen: string[] = [];
    const dw = { queryTemplate: async (sql: string) => { seen.push(sql); return []; } } as any;   // A2 Phase 4 受信模板通道
    const { obsExtension } = await import("@away_from/pth-kernel-interpreter");
    const obs = obsExtension.provide!({ dataWorld: dw } as any)["obs"] as any;
    await obs.search({ query: "o'Reilly" });
    expect(seen[0]).toContain("o''Reilly");
  });

  it("obs.metrics/batches：IPC 不可用 → 明确错误（非 batch 进程）", async () => {
    const { obsExtension } = await import("@away_from/pth-kernel-interpreter");
    const obs = obsExtension.provide!({ dataWorld: { queryReadOnly: async () => [] } as any } as any)["obs"] as any;
    const r = await obs.metrics({ pattern: "pth_" });
    expect(r.error).toBeDefined();
  });
});
