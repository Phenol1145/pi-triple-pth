import { describe, it, expect } from "vitest";
import { detectNaturalLanguage, translateTask } from "../../src/pth/kernel/execution/nl-translator.js";
import type { LlmFn } from "../../src/pth/kernel/interpreter/llm-fn.js";

describe("detectNaturalLanguage（启发式检测）", () => {
  it("代码特征 → 非 NL", () => {
    expect(detectNaturalLanguage('return { x: 1 };')).toBe(false);
    expect(detectNaturalLanguage('function f(n) { return n * 2; }')).toBe(false);
    expect(detectNaturalLanguage('const r = await python.execute("_result = 1")')).toBe(false);
    expect(detectNaturalLanguage('var c = 0; for (var i = 0; i < 10; i++) c += i; return { c };')).toBe(false);
  });

  it("自然语言句子 → NL", () => {
    expect(detectNaturalLanguage("帮我计算 1 到 100 的和，并返回结果")).toBe(true);
    expect(detectNaturalLanguage("用 python 算一下斐波那契数列第 20 项")).toBe(true);
    expect(detectNaturalLanguage("查询当前系统时间并返回")).toBe(true);
  });

  it("payload.kind=nl 强制（短文本也按 NL）", () => {
    expect(detectNaturalLanguage("统计质数", true)).toBe(true);
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

  it("prompt 包含能力白名单（转译产物可用 python/bash/llm/web/fs/state）", async () => {
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
    expect(seenSystem).toContain("return");
  });
});
