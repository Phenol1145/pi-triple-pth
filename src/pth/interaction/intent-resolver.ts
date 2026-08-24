/**
 * interaction/intent-resolver.ts —— N25 Intent Resolver（确定性 v1）。
 *
 * 完整协议要求 LLM 提议 + 服务器裁决；本模块提供服务器侧确定性裁决骨架：
 * 输入文本 → IntentProposal（mode + confidence）。
 */

import type { IntentMode, IntentProposal } from "@away_from/pth-contracts";

const REQUEST_HINTS = [
  "实现", "编写", "写", "修复", "构建", "测试", "计算", "分析", "调研", "生成",
  "create", "write", "fix", "build", "test", "compute", "analyze", "research",
];

export function resolveIntent(text: string): IntentProposal {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { mode: "chitchat", confidence: 0.5, reason: "空输入" };

  const lower = trimmed.toLowerCase();
  const hasQuestion = trimmed.includes("?") || trimmed.includes("？");
  const hasRequestHint = REQUEST_HINTS.some((h) => lower.includes(h.toLowerCase()));

  if (hasRequestHint && trimmed.length >= 4) {
    return { mode: "request", confidence: hasQuestion ? 0.7 : 0.85, title: trimmed.slice(0, 40), text: trimmed };
  }
  if (hasQuestion) {
    return { mode: "discussion", confidence: 0.6, text: trimmed };
  }
  return { mode: "chitchat", confidence: 0.55, text: trimmed };
}
