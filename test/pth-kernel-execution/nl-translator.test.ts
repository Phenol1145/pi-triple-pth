import { describe, it, expect } from "vitest";
import { translateTask } from "@away_from/pth-kernel-execution";
import type { LlmFn } from "@away_from/pth-kernel-interpreter";

// 任务池纯化（2026-08-10 D1）：isNaturalLanguageTask 已删除——任务池全 NL，无需判定。
// 本文件只保留 translateTask（降级通道）测试。

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

// flow 判定测试已随 isNaturalLanguageTask 一并删除（任务池纯化——flow 任务天然走 agent 循环，
// 由 task-loop 主路径覆盖）
