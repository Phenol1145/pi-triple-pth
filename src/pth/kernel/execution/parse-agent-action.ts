/**
 * parse-agent-action —— LLM 输出 → 工具动作解析（agent 循环的解析层）。
 *
 * 容错链：剥离 markdown 围栏 → 提取首个 JSON 对象 → 校验 tool 白名单 → args 必填校验。
 * 解析失败由调用方重试（PTH_AGENT_RETRY_PARSE）→ 仍失败 terminal reject。
 */

export const AGENT_TOOL_IDS = [
  "ts",
  "python.execute",
  "bash.execute",
  "done",
] as const;

export type AgentToolId = (typeof AGENT_TOOL_IDS)[number];

export interface AgentAction {
  thought?: string;
  tool: AgentToolId;
  args: Record<string, unknown>;
}

export type ParseResult =
  | { ok: true; action: AgentAction }
  | { ok: false; error: string };

export function isKnownTool(tool: string): tool is AgentToolId {
  return (AGENT_TOOL_IDS as readonly string[]).includes(tool);
}

/** 剥离 markdown 代码块围栏（```json / ``` 包裹），返回最内层内容 */
function stripFence(output: string): string {
  const m = output.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  return m ? m[1]! : output;
}

/** 提取首个 JSON 对象（容错：容忍前后多余文字） */
function extractFirstJson(text: string): { obj: Record<string, unknown>; raw: string } | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  // 从 { 开始做括号配对（处理嵌套 + 字符串内 {} 不干扰——简化：配对计数）
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const raw = text.slice(start, i + 1);
        try {
          return { obj: JSON.parse(raw) as Record<string, unknown>, raw };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function parseAgentAction(output: string): ParseResult {
  const cleaned = stripFence(output);
  const found = extractFirstJson(cleaned);
  if (!found) return { ok: false, error: "action-parse-failed: 输出中无有效 JSON 对象" };

  const { obj } = found;
  const actionField = obj["action"];
  if (!actionField || typeof actionField !== "object" || Array.isArray(actionField)) {
    return { ok: false, error: "action-parse-failed: 缺少 action 对象" };
  }
  const a = actionField as Record<string, unknown>;
  const tool = a["tool"];
  if (typeof tool !== "string" || !isKnownTool(tool)) {
    return { ok: false, error: `action-parse-failed: 未知工具 "${String(tool)}"` };
  }
  const args = a["args"];
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: `action-parse-failed: 工具 ${tool} 缺少 args 对象` };
  }
  const thought = typeof obj["thought"] === "string" ? obj["thought"] : undefined;
  return { ok: true, action: { thought, tool, args: args as Record<string, unknown> } };
}
