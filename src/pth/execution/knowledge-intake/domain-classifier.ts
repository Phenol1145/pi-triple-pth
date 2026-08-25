/**
 * execution/knowledge-intake/domain-classifier.ts —— N26 多域广度：领域分类 v1。
 */

export type KnowledgeDomain = "code" | "research" | "operations" | "general";

const CODE_HINTS = ["code", "api", "typescript", "python", "compiler", "kernel"];
const RESEARCH_HINTS = ["paper", "research", "survey", "analysis", "study"];
const OPERATIONS_HINTS = ["ops", "runbook", "incident", "deploy", "monitor"];

export function classifyDomain(text: string): KnowledgeDomain {
  const lower = text.toLowerCase();
  if (CODE_HINTS.some((h) => lower.includes(h))) return "code";
  if (RESEARCH_HINTS.some((h) => lower.includes(h))) return "research";
  if (OPERATIONS_HINTS.some((h) => lower.includes(h))) return "operations";
  return "general";
}
