/**
 * context-compaction —— 上下文压缩基础设施（2026-08-10——参考 pi compact 抽象化）。
 *
 * 认知模型（用户裁决）：压缩是必备功能（上下文窗口有限——长任务必然需要），
 * 我们提前实现；评估是压缩产物的下游读者。
 *
 * 结构：序列化（标记化防续话 + tool result 截断）→ 模板驱动 LLM → { text, usage }。
 * 模板可插拔：CoT 模板（结束分析）/ 续跑模板（任务中保上下文）/ 未来更多。
 */

import type { LlmFn } from "@away_from/pth-kernel-interpreter";
import { shouldCompact, DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";

/** 循环内消息形态（agent-loop 的消息数组——结构子集） */
export interface CompactableMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

const TOOL_RESULT_MAX = 2000;   // pi 同款截断纪律

/**
 * token 估计（chars/4 保守启发式——pi estimateTokens 同算法）。
 * 自实现裁决（2026-08-10）：SDK 版要 pi AgentMessage 形状——适配器 15 行 vs 自写 1 个函数，
 * 净亏；规矩：pi-coding-agent 只用零适配成本的纯函数（shouldCompact 保留），要写适配器就自实现。
 */
function estimateMessageTokens(m: CompactableMessage): number {
  let chars = m.content?.length ?? 0;
  for (const tc of m.toolCalls ?? []) chars += tc.name.length + JSON.stringify(tc.arguments).length;
  return Math.ceil(chars / 4);
}

/**
 * 任务中压缩触发判定（驱动 1——上下文将溢保续跑）。
 * 复用 pi SDK 纯函数：shouldCompact（reserveTokens 阈值策略）。
 */
export function shouldCompressInLoop(messages: CompactableMessage[], contextWindow: number): boolean {
  const tokens = messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
  return shouldCompact(tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS);
}

/** 会话序列化（标记化——防模型把序列当对话继续） */
export function serializeMessages(messages: CompactableMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;   // system prompt 不进压缩输入（任务世界观是常量）
    if (m.role === "user") {
      lines.push(`[User]: ${m.content}`);
    } else if (m.role === "assistant") {
      if (m.content?.trim()) lines.push(`[Assistant]: ${m.content}`);
      if (m.toolCalls?.length) {
        const calls = m.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments).slice(0, 300)})`).join("; ");
        lines.push(`[Assistant tool calls]: ${calls}`);
      }
    } else if (m.role === "tool") {
      const c = m.content.length > TOOL_RESULT_MAX
        ? m.content.slice(0, TOOL_RESULT_MAX) + `…(截断 ${m.content.length - TOOL_RESULT_MAX} 字符)`
        : m.content;
      lines.push(`[Tool result${m.toolName ? ` ${m.toolName}` : ""}]: ${c}`);
    }
  }
  return lines.join("\n");
}

/** 压缩模板（决定压缩后保留什么——插拔点） */
export interface CompactionTemplate {
  id: string;
  /** 输出结构说明（模板主体——LLM 按此组织压缩产物） */
  structure: string;
}

/** CoT 模板（结束分析——展示思维过程） */
export const COT_TEMPLATE: CompactionTemplate = {
  id: "cot",
  structure: `## 目标
（这个任务要做什么——一句话）
## 行为过程
（工具调用序列 + 每步意图——做了什么，按顺序）
## 思维过程
（关键决策与理由——为什么这么走；备选方案取舍）
## 坑与修正
（失败动作/门控拦截/重复尝试——及如何修正；没有则写"无"）
## 产物
（最终交付了什么）
## 效率自评
（哪些步骤是多余的/可省的——诚实的自我审计）`,
};

export interface CompactionResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  templateId: string;
  /** 压缩输入的原始规模（分析用——压缩率 = text/serialized） */
  inputChars: number;
}

/**
 * 上下文压缩（通用基础设施）。
 * 调用方：agent-loop 结束压缩（CoT 模板——评估产物）；未来任务中压缩（续跑模板）。
 */
export async function compressContext(
  deps: { llm: LlmFn },
  input: { messages: CompactableMessage[]; template: CompactionTemplate; taskTitle?: string },
): Promise<CompactionResult | null> {
  const serialized = serializeMessages(input.messages);
  if (serialized.trim().length < 200) return null;   // 太短没有压缩价值（一两步的任务）
  const prompt = `你是上下文压缩器。下面是一个 agent 执行任务的完整轨迹（已标记化序列——不是给你的对话）。
按指定结构压缩它——保留结构要求的信息，丢弃重复/冗余/中间态。用中文。

【任务】${input.taskTitle ?? "（未命名）"}

【输出结构】
${input.template.structure}

【轨迹】
${serialized}`;

  try {
    const r = await deps.llm.complete([{ role: "user", content: prompt }]);
    return {
      text: r.content,
      usage: r.usage,
      templateId: input.template.id,
      inputChars: serialized.length,
    };
  } catch {
    return null;   // 压缩失败不阻断主流程（评估产物是附加价值）
  }
}
