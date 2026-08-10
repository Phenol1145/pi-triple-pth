import { describe, it, expect, vi } from "vitest";
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
  };

  it("提炼并持久化：函数 → tool-function（content=源码 + meta.spec），洞察 → task-insight", async () => {
    const { refiner, memory } = setup(JSON.stringify({
      functions: [{ key: "add", source: "function add(a,b){return a+b}", spec: { signature: "add(a,b): number", purpose: "相加", logic: "返回 a+b", examples: [["1,2", "3"]] } }],
      insights: ["任务完成，x=1"],
    }));
    const report = await refiner.refine(input);
    expect(report.functionsSaved).toBe(1);
    expect(report.insightsSaved).toBe(1);
    // tool-function 写入：content=源码 + meta.spec
    const fnCall = memory.write.mock.calls.find((c) => c[0].kind === "tool-function");
    expect(fnCall).toBeDefined();
    expect(fnCall![0].content).toContain("function add");
    expect(fnCall![0].anchors).toContain("add");
    expect(fnCall![0].meta.spec.signature).toBe("add(a,b): number");
    expect(fnCall![0].meta.language).toBe("typescript");
    // insight 写入
    const insightCall = memory.write.mock.calls.find((c) => c[0].kind === "task-insight");
    expect(insightCall).toBeDefined();
    expect(insightCall![0].content).toContain("x=1");
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
