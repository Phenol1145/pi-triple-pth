/**
 * pth/bench/scripted-llm.ts —— PTH Bench W3：ScriptedLlmFn。
 *
 * L0 确定性 LLM：按场景剧本依次吐 toolCalls / content，最后必须 done。
 * 与 PTH_LLM_STUB（立即 done）不同，可演练多轮工具调用。
 */

import type { LlmFn, LlmMessage, LlmCompleteOptions, LlmResult } from "@away_from/pth-kernel-interpreter";

export interface ScriptedLlmTurn {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export class ScriptedLlmFn implements LlmFn {
  private callCount = 0;

  constructor(private readonly turns: ScriptedLlmTurn[]) {}

  async complete(_messages: LlmMessage[], _opts?: LlmCompleteOptions): Promise<LlmResult> {
    const turn = this.turns[Math.min(this.callCount++, this.turns.length - 1)] ?? { toolCalls: [{ name: "done", arguments: { result: "scripted-done" } }] };
    return {
      content: turn.content ?? "",
      model: "scripted",
      toolCalls: turn.toolCalls?.map((tc, i) => ({ id: `scripted-${i}`, name: tc.name, arguments: tc.arguments })),
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}
