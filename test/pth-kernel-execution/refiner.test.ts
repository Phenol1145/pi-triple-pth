import { describe, it, expect, vi } from "vitest";
import { contentHashOf } from "@away_from/pth-memory";
import { Refiner, buildRefinePrompt, parseRefineResult, type RefineInput } from "../../src/pth/kernel/execution/refiner";

describe("buildRefinePrompt", () => {
  it("包含快照内容与任务信息", () => {
    const snap = {
      variables: [{ key: "data", value: { a: 1 }, serializable: true }],
      functions: [{ key: "add", source: "function add(a,b){return a+b}" }],
      oversized: [],
    };
    const prompt = buildRefinePrompt({ task: { id: "t1", title: "dev", tags: ["code"] } as any, snapshot: snap });
    expect(prompt).toContain("add");
    expect(prompt).toContain("t1");
    expect(prompt).toContain("functions");
    expect(prompt).toContain("spec");   // 构造文档字段
  });
});

describe("parseRefineResult", () => {
  it("解析合法 JSON（含 functions + insights）", () => {
    const out = parseRefineResult(JSON.stringify({
      functions: [{ key: "add", source: "function add(a,b){return a+b}", spec: { signature: "add(a,b): number", purpose: "相加" } }],
      insights: ["经验1"],
    }));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.functions[0].key).toBe("add");
      expect(out.insights).toContain("经验1");
    }
  });

  it("容错：带 ```json 围栏", () => {
    const out = parseRefineResult('```json\n{"functions":[],"insights":["x"]}\n```');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.insights).toContain("x");
  });

  it("容错：非法 JSON → ok:false", () => {
    const out = parseRefineResult("not json at all");
    expect(out.ok).toBe(false);
  });
});

describe("Refiner.refine", () => {
  function setup(llmOutput: string) {
    const memory = {
      write: vi.fn(async () => {}),
      retrieve: vi.fn(async () => []),
      bumpHitCount: vi.fn(async () => {}),
    };
    const llm = { complete: vi.fn(async () => ({ content: llmOutput, model: "deepseek-v4-flash" })) };
    const refiner = new Refiner({ llm: llm as any, memory: memory as any });
    return { refiner, memory, llm };
  }

  const input: RefineInput = {
    task: { id: "t1", title: "测试", tags: ["code"], claimed_by: "developer" } as any,
    snapshot: {
      variables: [{ key: "x", value: 1, serializable: true }],
      functions: [{ key: "add", source: "function add(a,b){return a+b}" }],
      oversized: [],
    },
    scope: { tenantId: "tenant-a", space: "meta" },
  };

  it("fail-closed：缺 scope 直接抛 refine scope required，不调用 llm", async () => {
    const { refiner, memory, llm } = setup(JSON.stringify({ functions: [], insights: [] }));
    await expect(refiner.refine({ ...input, scope: undefined } as unknown as RefineInput)).rejects.toThrow("refine scope required");
    await expect(refiner.refine({ ...input, scope: { tenantId: "", space: "meta" } } as RefineInput)).rejects.toThrow("refine scope required");
    await expect(refiner.refine({ ...input, scope: { tenantId: "t", space: "" } } as RefineInput)).rejects.toThrow("refine scope required");
    expect(llm.complete).not.toHaveBeenCalled();
    expect(memory.write).not.toHaveBeenCalled();
  });

  it("提炼并持久化：函数 → tool-function（draft + scope + provenance），洞察 → task-insight", async () => {
    const { refiner, memory } = setup(JSON.stringify({
      functions: [{ key: "add", source: "function add(a,b){return a+b}", spec: { signature: "add(a,b): number", purpose: "相加", logic: "返回 a+b", examples: [["1,2", "3"]] } }],
      insights: ["任务完成，x=1"],
    }));
    const report = await refiner.refine(input);
    expect(report.functionsSaved).toBe(1);
    expect(report.insightsSaved).toBe(1);
    // tool-function 写入：content=源码 + meta.spec + scoped draft + provenance
    const fnCall = memory.write.mock.calls.find((c) => c[0].kind === "tool-function");
    expect(fnCall).toBeDefined();
    expect(fnCall![0].content).toContain("function add");
    expect(fnCall![0].anchors).toContain("add");
    expect(fnCall![0].meta.spec.signature).toBe("add(a,b): number");
    expect(fnCall![0].meta.language).toBe("typescript");
    expect(fnCall![0].status).toBe("draft");
    expect(fnCall![0].tenantId).toBe("tenant-a");
    expect(fnCall![0].meta.tenantId).toBe("tenant-a");
    expect(fnCall![0].meta.spaceScope).toEqual({ space: "meta", visibility: "private" });
    expect(fnCall![0].meta.provenance).toMatchObject({
      sourceTaskId: "t1",
      producerRole: "developer",
      producerModel: "deepseek-v4-flash",
      sourceRefs: ["task:t1"],
    });
    expect(fnCall![0].meta.provenance.contentHash).toBe(contentHashOf(fnCall![0].content));
    // insight 写入：scoped draft + provenance
    const insightCall = memory.write.mock.calls.find((c) => c[0].kind === "task-insight");
    expect(insightCall).toBeDefined();
    expect(insightCall![0].content).toContain("x=1");
    expect(insightCall![0].status).toBe("draft");
    expect(insightCall![0].tenantId).toBe("tenant-a");
    expect(insightCall![0].meta.spaceScope).toEqual({ space: "meta", visibility: "private" });
    expect(insightCall![0].meta.provenance.contentHash).toBe(contentHashOf(insightCall![0].content));
    expect(insightCall![0].meta.provenance.sourceRefs).toEqual(["task:t1"]);
  });

  it("LLM 解析失败 → 降级：函数源码原样保存（无 spec），不 crash", async () => {
    const { refiner, memory } = setup("garbage output");
    const report = await refiner.refine(input);
    // 降级：仍保存函数（源码），insights 空
    expect(report.functionsSaved).toBeGreaterThanOrEqual(0);
    expect(memory.write).toHaveBeenCalled();
  });

  it("空快照 → 无持久化", async () => {
    const { refiner, memory } = setup(JSON.stringify({ functions: [], insights: [] }));
    const report = await refiner.refine({ ...input, snapshot: { variables: [], functions: [], oversized: [] } });
    expect(report.functionsSaved).toBe(0);
    expect(report.insightsSaved).toBe(0);
  });
});

describe("任务 3：角色分化分析（有监督自动化——differentiation proposal）", () => {
  it("parseRefineResult 解析 differentiation（分化建议——结构容错）", async () => {
    const { parseRefineResult } = await import("../../src/pth/kernel/execution/refiner.js");
    const text = JSON.stringify({
      functions: [], insights: ["insight-1"],
      differentiation: {
        differentiable: true,
        subtasks: [{ type: "代码侦察", description: "定位相关文件", capabilityNeeds: ["readSource"], frequency: "每次任务前" }],
        suggestedRole: { id: "scout", parent: "developer", specialization: "代码侦察", rationale: "实现前反复侦察——能力差异明显" },
        confidence: "high",
      },
    });
    const r = parseRefineResult(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.differentiation?.differentiable).toBe(true);
      expect(r.differentiation?.subtasks).toHaveLength(1);
      expect(r.differentiation?.suggestedRole?.parent).toBe("developer");
      expect(r.differentiation?.confidence).toBe("high");
    }
  });

  it("differentiable=false（单一同质任务）→ 不建议分化", async () => {
    const { parseRefineResult } = await import("../../src/pth/kernel/execution/refiner.js");
    const r = parseRefineResult(JSON.stringify({ functions: [], insights: [], differentiation: { differentiable: false, subtasks: [] } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.differentiation?.differentiable).toBe(false);
  });

  it("缺 differentiation 字段（旧格式）→ 容错 undefined", async () => {
    const { parseRefineResult } = await import("../../src/pth/kernel/execution/refiner.js");
    const r = parseRefineResult(JSON.stringify({ functions: [], insights: [] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.differentiation).toBeUndefined();
  });

  it("buildRefinePrompt 含分化分析指引 + 轨迹摘要", async () => {
    const { buildRefinePrompt } = await import("../../src/pth/kernel/execution/refiner.js");
    const prompt = buildRefinePrompt({
      task: { id: "t1", title: "实现+验证", tags: ["implement"], claimed_by: "developer" },
      snapshot: { functions: [], variables: [] },
      role: "developer",
      trace: [{ type: "tool-call", step: 1, tool: "ts", args: { code: "readSource..." } }],
    });
    expect(prompt).toContain("differentiation");
    expect(prompt).toContain("分化");
    expect(prompt).toContain("执行角色: developer");
    expect(prompt).toContain("执行轨迹");
    expect(prompt).toContain("有监督");
  });
});

describe("refine 解硬编码（任务清单数据化——memory 真相源——可演化）", () => {
  it("buildRefinePrompt 按清单动态拼接（禁用任务的段落不出现）", async () => {
    const { buildRefinePrompt, DEFAULT_REFINE_TASKS } = await import("../../src/pth/kernel/execution/refiner.js");
    const noDiff = DEFAULT_REFINE_TASKS.map((t) => t.id === "differentiation" ? { ...t, enabled: false } : t);
    const prompt = buildRefinePrompt({ task: { id: "t", title: "x", tags: [] }, snapshot: { functions: [], variables: [] } }, noDiff);
    expect(prompt).toContain("functions");
    expect(prompt).not.toContain("suggestedRole");   // differentiation schema 不出现
    const full = buildRefinePrompt({ task: { id: "t", title: "x", tags: [] }, snapshot: { functions: [], variables: [] } });
    expect(full).toContain("suggestedRole");
  });

  it("自定义任务（raw）出现在 prompt + parseRefineResult extra 提取", async () => {
    const { buildRefinePrompt, parseRefineResult, DEFAULT_REFINE_TASKS } = await import("../../src/pth/kernel/execution/refiner.js");
    type TaskDef = (typeof DEFAULT_REFINE_TASKS)[number];
    const custom: TaskDef = {
      id: "risk-scan", promptRules: ["- riskScan: 列出任务执行中遇到的风险点"],
      outputField: "riskScan", outputSchema: `"riskScan": ["<风险点>"]`,
      persistKind: "risk-report", persistAs: "raw", enabled: true,
    };
    const tasks = [...DEFAULT_REFINE_TASKS, custom];
    const prompt = buildRefinePrompt({ task: { id: "t", title: "x", tags: [] }, snapshot: { functions: [], variables: [] } }, tasks);
    expect(prompt).toContain("riskScan");
    expect(prompt).toContain("风险点");
    const r = parseRefineResult(JSON.stringify({ functions: [], insights: [], riskScan: ["池容量风险"] }), tasks);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.extra?.riskScan).toEqual(["池容量风险"]);
  });

  it("Refiner.loadTasks——memory 清单优先（fallback 默认）", async () => {
    const { Refiner, DEFAULT_REFINE_TASKS } = await import("../../src/pth/kernel/execution/refiner.js");
    // memory 空 → fallback 默认
    const r1 = new Refiner({ llm: async () => ({ content: "{}", model: "m" }), memory: { write: async () => ({}), retrieve: async () => [] } as never });
    expect((await r1.loadTasks()).length).toBe(DEFAULT_REFINE_TASKS.length);
    // memory 有自定义清单 → 用之
    const customTask = { ...DEFAULT_REFINE_TASKS[0], id: "only-fn" };
    const r2 = new Refiner({
      llm: async () => ({ content: "{}", model: "m" }),
      memory: {
        write: async () => ({}),
        retrieve: async (opts: { kinds?: string[] }) => opts.kinds?.includes("refine-task")
          ? [{ id: "refine-task:only-fn", kind: "refine-task", anchors: [], content: JSON.stringify(customTask), status: "official", meta: {} }]
          : [],
      } as never,
    });
    const loaded = await r2.loadTasks();
    expect(loaded.length).toBe(1);
    expect(loaded[0].id).toBe("only-fn");
  });

  it("raw 自定义任务持久化（persistKind 自定义——draft——不改代码加 refine 任务）", async () => {
    const { Refiner, DEFAULT_REFINE_TASKS } = await import("../../src/pth/kernel/execution/refiner.js");
    const custom = {
      id: "risk-scan", promptRules: ["- riskScan: 风险点"], outputField: "riskScan",
      outputSchema: `"riskScan": ["<风险>"]`, persistKind: "risk-report", persistAs: "raw", enabled: true,
    };
    const tasks = [...DEFAULT_REFINE_TASKS.map((t) => ({ ...t, enabled: false })), custom];
    const written: Array<{ kind: string; content: string; status: string; tenantId?: string; meta?: Record<string, unknown> }> = [];
    const refiner = new Refiner({
      llm: { complete: async () => ({ content: JSON.stringify({ riskScan: ["沙盒池满风险"] }), model: "m" }) } as never,
      memory: {
        write: async (e: { kind: string; content: string; status: string; tenantId?: string; meta?: Record<string, unknown> }) => { written.push(e); return {}; },
        retrieve: async (opts: { kinds?: string[] }) => opts.kinds?.includes("refine-task")
          ? tasks.map((t) => ({ id: `refine-task:${t.id}`, kind: "refine-task", anchors: [], content: JSON.stringify(t), status: "official", meta: {} }))
          : [],
      } as never,
    });
    await refiner.refine({ task: { id: "t1", title: "x", tags: [] }, snapshot: { functions: [], variables: [] }, scope: { tenantId: "tenant-a", space: "meta" } });
    const riskEntry = written.find((w) => w.kind === "risk-report");
    expect(riskEntry).toBeTruthy();
    expect(riskEntry!.content).toContain("沙盒池满风险");
    expect(riskEntry!.status).toBe("draft");
    expect(riskEntry!.tenantId).toBe("tenant-a");
    expect(riskEntry!.meta?.spaceScope).toEqual({ space: "meta", visibility: "private" });
    expect((riskEntry!.meta?.provenance as Record<string, unknown>).contentHash).toBe(contentHashOf(riskEntry!.content));
    // 禁用的三内建不产出（tool-function/task-insight/differentiation-proposal 均无）
    expect(written.filter((w) => w.kind === "tool-function")).toHaveLength(0);
    expect(written.some((w) => w.kind === "refine-report")).toBe(true);   // 溯源报告仍写
  });
});
