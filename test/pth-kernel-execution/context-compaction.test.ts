import { describe, it, expect } from "vitest";
import { serializeMessages, compressContext, COT_TEMPLATE } from "../../src/pth/kernel/execution/context-compaction.js";
import type { AgentTraceEvent } from "../../src/pth/kernel/execution/agent-loop.js";

describe("context-compaction（压缩基础设施）", () => {
  it("序列化：标记化 + system 跳过 + tool result 截断", () => {
    const out = serializeMessages([
      { role: "system", content: "世界观" },
      { role: "user", content: "任务X" },
      { role: "assistant", content: "思考", toolCalls: [{ name: "ts", arguments: { code: "return 1" } }] },
      { role: "tool", toolName: "ts", content: "y".repeat(3000) },
    ]);
    expect(out).not.toContain("世界观");
    expect(out).toContain("[User]: 任务X");
    expect(out).toContain("[Assistant tool calls]: ts(");
    expect(out).toContain("截断 1000 字符");
  });

  it("短轨迹不压缩（<200c → null）", async () => {
    const r = await compressContext(
      { llm: { complete: async () => ({ content: "x", model: "m" }) } },
      { messages: [{ role: "user", content: "hi" }], template: COT_TEMPLATE },
    );
    expect(r).toBeNull();
  });

  it("压缩产出含模板结构 + usage 入账 + inputChars", async () => {
    let prompt = "";
    const mockLlm = {
      complete: async (msgs: Array<{ content: string }>) => {
        prompt = msgs[0]!.content;
        return { content: "## 目标\n测试", model: "m", usage: { inputTokens: 100, outputTokens: 50 } };
      },
    };
    const r = await compressContext(
      { llm: mockLlm as never },
      { messages: [
        { role: "user", content: "任务：计算 1 到 100 的和并验证结果是否正确，需要多步推理与工具调用才能完成整个流程，包括检索记忆库、执行计算、交叉验证和结果提交等多个阶段。" },
        { role: "assistant", content: "我先查记忆库里有没有现成的方法和之前类似的任务洞察可以参考，然后再决定用 python 还是 ts 来执行计算，最后还要验证结果的正确性。" },
        { role: "tool", toolName: "ts", content: "查询结果：找到 3 条相关记忆条目，包含之前任务的计算方法和验证策略的详细内容。" },
      ], template: COT_TEMPLATE, taskTitle: "求和任务" },
    );
    expect(r).not.toBeNull();
    expect(r!.text).toContain("## 目标");
    expect(r!.usage?.inputTokens).toBe(100);
    expect(r!.templateId).toBe("cot");
    expect(prompt).toContain("效率自评");   // CoT 模板结构进 prompt
    expect(prompt).toContain("求和任务");
  });

  it("LLM 失败 → null（不阻断主流程）", async () => {
    const r = await compressContext(
      { llm: { complete: async () => { throw new Error("llm down"); } } },
      { messages: [{ role: "user", content: "一个足够长的任务描述，需要超过二百字符的轨迹内容才会触发压缩流程，所以这里多写一些内容来凑够长度门槛，确保压缩被真正调用才行。" }], template: COT_TEMPLATE },
    );
    expect(r).toBeNull();
  });
});

// E3：scorecard 聚合器
import { buildScorecard } from "../../src/pth/kernel/execution/worker-scorecard.js";

describe("worker-scorecard（事件流轻聚合）", () => {
  const EVENTS: AgentTraceEvent[] = [
    { type: "llm-call", step: 0, contentPreview: "任务" },
    { type: "llm-call", step: 1, toolCalls: [{ name: "asp_cd", arguments: { space: "ts" } }], contentPreview: "", usage: { inputTokens: 1000, outputTokens: 100 } },
    { type: "tool-call", step: 1, tool: "asp_cd", args: { space: "ts" } },
    { type: "tool-result", step: 1, tool: "asp_cd", ok: true, durationMs: 5, resultPreview: "cd → ts" },
    { type: "llm-call", step: 2, toolCalls: [{ name: "ts", arguments: { code: "x" } }], contentPreview: "", usage: { inputTokens: 1200, outputTokens: 200 } },
    { type: "tool-call", step: 2, tool: "ts", args: { code: "x" } },
    { type: "tool-result", step: 2, tool: "ts", ok: false, durationMs: 30, resultPreview: "error: boom" },
    { type: "tool-call", step: 3, tool: "python_execute", args: { code: "print(1)" } },
    { type: "tool-result", step: 3, tool: "python_execute", ok: false, durationMs: 0, resultPreview: "空间门控：需 python" },
    { type: "finish", ok: true, steps: 4, valuePreview: "{...}" },
  ];

  it("工具频率 + token 汇总 + 失败/门控/导航指标", () => {
    const sc = buildScorecard(EVENTS);
    expect(sc.steps).toBe(4);
    expect(sc.toolFreq).toMatchObject({ asp_cd: 1, ts: 1, python_execute: 1 });
    expect(sc.tokens.input).toBe(2200);
    expect(sc.tokens.output).toBe(300);
    expect(sc.failedActions).toBe(2);         // ts error + 门控
    expect(sc.gatedActions).toBe(1);          // 空间门控
    expect(sc.aspNav.cds).toBe(1);
  });

  it("空事件流容错", () => {
    const sc = buildScorecard([]);
    expect(sc.steps).toBe(0);
    expect(sc.toolFreq).toEqual({});
  });
});

describe("shouldCompressInLoop（pi SDK 复用——任务中压缩触发）", () => {
  it("上下文未超阈值 → false；超阈值 → true", async () => {
    const { shouldCompressInLoop } = await import("../../src/pth/kernel/execution/context-compaction.js");
    const small = [{ role: "user", content: "短任务" }] as never;
    expect(shouldCompressInLoop(small, 128000)).toBe(false);
    // 构造超阈值的会话（contextWindow 调小模拟）
    const big = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: "x".repeat(2000) + i })) as never;
    expect(shouldCompressInLoop(big, 1000)).toBe(true);   // 40KB 内容 vs 1000 token 窗口
  });

  it("tool/assistant/toolCalls 形状正确估算（不抛错）", async () => {
    const { shouldCompressInLoop } = await import("../../src/pth/kernel/execution/context-compaction.js");
    const msgs = [
      { role: "user", content: "任务" },
      { role: "assistant", content: "思考", toolCalls: [{ name: "ts", arguments: { code: "x".repeat(500) } }] },
      { role: "tool", toolName: "ts", content: "y".repeat(500) },
    ] as never;
    expect(typeof shouldCompressInLoop(msgs, 128000)).toBe("boolean");
  });
});
