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
