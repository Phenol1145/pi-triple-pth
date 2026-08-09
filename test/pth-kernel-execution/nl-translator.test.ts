import { describe, it, expect } from "vitest";
import { isNaturalLanguageTask, translateTask } from "../../src/pth/kernel/execution/nl-translator.js";
import type { LlmFn } from "../../src/pth/kernel/interpreter/llm-fn.js";

describe("isNaturalLanguageTask（标签为主要分类凭据）", () => {
  it("tags 含 nl → 自然语言任务", () => {
    expect(isNaturalLanguageTask({ tags: ["nl"], text: "帮我算和" })).toBe(true);
    expect(isNaturalLanguageTask({ tags: ["dev", "nl"] })).toBe(true);
    expect(isNaturalLanguageTask({ tags: ["NL"] })).toBe(true);  // 大小写不敏感
  });

  it("payload.kind=nl → 自然语言任务（与标签等价）", () => {
    expect(isNaturalLanguageTask({ payload: { kind: "nl" } })).toBe(true);
  });

  it("无 nl 标签 → 一律按代码（即使长得像自然语言——不做正则强行筛）", () => {
    expect(isNaturalLanguageTask({ tags: ["dev"], text: "帮我计算 1 到 100 的和" })).toBe(false);
    expect(isNaturalLanguageTask({ tags: [], text: "随便写点文字" })).toBe(false);
    expect(isNaturalLanguageTask({})).toBe(false);
  });
});

describe("translateTask（LLM 转译）", () => {
  it("LLM 返回代码 → ok:true + code（剥离代码块围栏）", async () => {
    const llm: LlmFn = {
      complete: async () => ({ ok: true, content: '```ts\nreturn { sum: 5050 };\n```', durationMs: 10, usage: {} }),
    };
    const r = await translateTask({ llm }, { title: "求和", text: "计算 1 到 100 的和" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.code).toBe("return { sum: 5050 };");
  });

  it("LLM 抛错 → 降级 ok:false（调用方 terminal reject）", async () => {
    const llm: LlmFn = {
      complete: async () => { throw new Error("provider down"); },
    };
    const r = await translateTask({ llm }, { title: "x", text: "随便做点啥" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("provider down");
  });

  it("prompt 包含能力白名单 + Observation 协议说明", async () => {
    let seenSystem = "";
    const llm: LlmFn = {
      complete: async (messages) => {
        seenSystem = messages[0]?.content ?? "";
        return { ok: true, content: "return { ok: true };", durationMs: 5, usage: {} };
      },
    };
    await translateTask({ llm }, { title: "t", text: "用 bash 看看" });
    expect(seenSystem).toContain("python.execute");
    expect(seenSystem).toContain("bash.execute");
    expect(seenSystem).toContain(".value");          // Observation 协议说明
    expect(seenSystem).toContain("return");
  });
});

describe("flow 声明 = agent 任务（补充任务实测——无 nl 标签的 flow 任务走了转译路径）", () => {
  it("payload.flow 存在 → 视为自然语言任务（agent 循环）", async () => {
    const { isNaturalLanguageTask } = await import("../../src/pth/kernel/execution/nl-translator.js");
    expect(isNaturalLanguageTask({ title: "t", text: "x", tags: [], payload: { flow: { stages: [{ task: { role: "developer" } }] } } })).toBe(true);
  });
  it("无 flow 无 nl 标签 → 非自然语言任务（代码任务 fast-path）", async () => {
    const { isNaturalLanguageTask } = await import("../../src/pth/kernel/execution/nl-translator.js");
    expect(isNaturalLanguageTask({ title: "t", text: "x", tags: [], payload: {} })).toBe(false);
  });
});
