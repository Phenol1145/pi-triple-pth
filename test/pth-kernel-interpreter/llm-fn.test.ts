import { describe, it, expect } from "vitest";
import { createLlmFn } from "../../src/pth/kernel/interpreter/llm-fn";

/** mock ModelRuntime（对齐 pi ModelRuntime.completeSimple 签名） */
function mockRuntime(impl?: (model: any, context: any) => Promise<any>) {
  return {
    completeSimple: impl ?? (async (_model: any, context: any) => ({
      role: "assistant",
      content: [{ type: "text", text: `reply to ${context.messages.map((m: any) => m.content).join("|")}` }],
      api: "mock", provider: "mock", model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn", timestamp: Date.now(),
    })),
  } as any;
}

/** mock ModelRouter（对齐 router.ts 的 resolve/getRuntime） */
function mockRouter(runtime: any) {
  return {
    resolve: () => ({ id: "mock-model", api: "mock" }),
    getRuntime: () => runtime,
  } as any;
}

describe("llm function", () => {
  it("complete calls completeSimple via model-router", async () => {
    const runtime = mockRuntime();
    const llm = createLlmFn({ modelRouter: mockRouter(runtime) });
    const res = await llm.complete([{ role: "user", content: "hello" }]);
    expect(res.content).toContain("hello");
    expect(res.model).toBe("mock-model");
    expect(res.usage?.inputTokens).toBe(10);
  });

  it("converts system messages to systemPrompt", async () => {
    let seenContext: any;
    const runtime = mockRuntime(async (_model: any, context: any) => {
      seenContext = context;
      return { role: "assistant", content: [{ type: "text", text: "ok" }], api: "a", provider: "p", model: "m", usage: {}, stopReason: "end_turn", timestamp: Date.now() };
    });
    const llm = createLlmFn({ modelRouter: mockRouter(runtime) });
    await llm.complete([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]);
    expect(seenContext.systemPrompt).toBe("you are helpful");
    expect(seenContext.messages[0].role).toBe("user");
    expect(seenContext.messages[0].content).toBe("hi");
    expect(typeof seenContext.messages[0].timestamp).toBe("number");
  });

  it("converts assistant messages to TextContent array (real-provider compat)", async () => {
    let seenContext: any;
    const runtime = mockRuntime(async (_model: any, context: any) => {
      seenContext = context;
      return { role: "assistant", content: [{ type: "text", text: "ok" }], api: "a", provider: "p", model: "m", usage: {}, stopReason: "end_turn", timestamp: Date.now() };
    });
    const llm = createLlmFn({ modelRouter: mockRouter(runtime) });
    await llm.complete([
      { role: "user", content: "hi" },
      { role: "assistant", content: "assistant reply text" },
    ]);
    // user 消息保持字符串（pi-ai user 分支兼容字符串）
    expect(seenContext.messages[0].role).toBe("user");
    expect(seenContext.messages[0].content).toBe("hi");
    // assistant 消息 content 必须是 TextContent[] 数组形态（对齐 pi-ai AssistantMessage.content）
    expect(seenContext.messages[1].role).toBe("assistant");
    expect(seenContext.messages[1].content).toEqual([{ type: "text", text: "assistant reply text" }]);
    expect(typeof seenContext.messages[1].timestamp).toBe("number");
  });

  it("extracts text from assistant content array", async () => {
    const runtime = mockRuntime(async () => ({
      role: "assistant",
      content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      api: "a", provider: "p", model: "m", usage: {}, stopReason: "end_turn", timestamp: Date.now(),
    }));
    const llm = createLlmFn({ modelRouter: mockRouter(runtime) });
    const res = await llm.complete([{ role: "user", content: "x" }]);
    expect(res.content).toBe("firstsecond");
  });

  it("passes model/provider to resolve", async () => {
    let seenModel: any;
    const router = {
      resolve: (provider?: string, model?: string) => { seenModel = { provider, model }; return { id: "m", api: "a" }; },
      getRuntime: () => mockRuntime(),
    } as any;
    const llm = createLlmFn({ modelRouter: router });
    await llm.complete([{ role: "user", content: "x" }], { model: "qwen3.8-max", provider: "p1" });
    expect(seenModel).toEqual({ provider: "p1", model: "qwen3.8-max" });
  });
});

describe("direct 路径缓存字段（2026-08-12 审计 HIGH-3 修复）", () => {
  it("tools 非空走 direct——解析 prompt_cache_hit_tokens/miss_tokens 到 usage", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok", tool_calls: [{ id: "t1", function: { name: "ts.run", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    process.env.DEEPSEEK_API_KEY = "test-key";
    const llm = createLlmFn({ modelRouter: mockRouter(mockRuntime()) });
    const res = await llm.complete([{ role: "user", content: "x" }], {
      model: "deepseek-v4-flash", provider: "deepseek",
      tools: [{ name: "ts.run", description: "d", parameters: { type: "object", properties: {} } }],
    });
    expect(res.usage?.cacheReadTokens).toBe(60);
    expect(res.usage?.cacheWriteTokens).toBe(40);
    expect(res.usage?.inputTokens).toBe(100);
    vi.unstubAllGlobals();
    delete process.env.DEEPSEEK_API_KEY;
  });
});

describe("B1 修复（2026-08-14）：reasoning_content 回传 + 序列补全", () => {
  const TOOL = [{ name: "probe", description: "d", parameters: { type: "object", properties: {} } }];

  it("assistant 带 thinking 时序列化 reasoning_content（deepseek v4 thinking 模式契约）", async () => {
    let body: any;
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    process.env.DEEPSEEK_API_KEY = "test-key";
    const llm = createLlmFn({ modelRouter: mockRouter(mockRuntime()) });
    await llm.complete([
      { role: "user", content: "x" },
      { role: "assistant", content: "", thinking: "思考内容", toolCalls: [{ id: "t1", name: "probe", arguments: { q: "a" } }] },
      { role: "tool", toolCallId: "t1", content: "ok" },
    ], { model: "deepseek-v4-flash", provider: "deepseek", tools: TOOL });
    // apiMessages = [user, assistant, tool]
    expect(body.messages[1].reasoning_content).toBe("思考内容");
    expect(body.messages[1].tool_calls).toEqual([{ id: "t1", type: "function", function: { name: "probe", arguments: "{\"q\":\"a\"}" } }]);
    vi.unstubAllGlobals();
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("无 thinking 的 assistant 不输出 reasoning_content 字段", async () => {
    let body: any;
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    process.env.DEEPSEEK_API_KEY = "test-key";
    const llm = createLlmFn({ modelRouter: mockRouter(mockRuntime()) });
    await llm.complete([
      { role: "user", content: "x" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "probe", arguments: {} }] },
      { role: "tool", toolCallId: "t1", content: "ok" },
    ], { model: "deepseek-v4-flash", provider: "deepseek", tools: TOOL });
    expect(body.messages[1].reasoning_content).toBeUndefined();
    vi.unstubAllGlobals();
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("悬挂 tool_calls（多调用只回了部分）→ 补合成 tool 响应保持序列", async () => {
    let body: any;
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    process.env.DEEPSEEK_API_KEY = "test-key";
    const llm = createLlmFn({ modelRouter: mockRouter(mockRuntime()) });
    await llm.complete([
      { role: "user", content: "x" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "probe", arguments: {} }, { id: "t2", name: "probe", arguments: {} }] },
      { role: "tool", toolCallId: "t1", content: "ok" },
    ], { model: "deepseek-v4-flash", provider: "deepseek", tools: TOOL });
    // user, assistant, tool(t1), 合成 tool(t2)
    expect(body.messages.length).toBe(4);
    expect(body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "t2" });
    expect(body.messages[3].content).toContain("序列补全");
    vi.unstubAllGlobals();
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("完整回应的多调用不补合成消息", async () => {
    let body: any;
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    process.env.DEEPSEEK_API_KEY = "test-key";
    const llm = createLlmFn({ modelRouter: mockRouter(mockRuntime()) });
    await llm.complete([
      { role: "user", content: "x" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "probe", arguments: {} }, { id: "t2", name: "probe", arguments: {} }] },
      { role: "tool", toolCallId: "t1", content: "ok" },
      { role: "tool", toolCallId: "t2", content: "ok2" },
    ], { model: "deepseek-v4-flash", provider: "deepseek", tools: TOOL });
    expect(body.messages.length).toBe(4);
    expect(body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "t2", content: "ok2" });
    vi.unstubAllGlobals();
    delete process.env.DEEPSEEK_API_KEY;
  });
});
