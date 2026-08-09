import type { Context, Tool } from "@earendil-works/pi-ai";
import type { ModelRouter } from "@pi-triple/infra";

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** tool 角色消息：关联的 toolCallId（OpenAI 原生工具调用回填） */
  toolCallId?: string;
  toolName?: string;
}

export interface LlmCompleteOptions {
  model?: string;
  provider?: string;
  thinking?: "off" | "low" | "medium" | "high";
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 工具声明（OpenAI function 格式——Context.tools——原生 tool_calls） */
  tools?: Tool[];
}

export interface LlmResult {
  content: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** 原生工具调用（模型返回结构化 tool_calls——非文本 JSON 解析） */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

export interface LlmFn {
  complete(messages: LlmMessage[], opts?: LlmCompleteOptions): Promise<LlmResult>;
}

/**
 * llm.complete —— LLM 作为数据处理算法（范式 P4）。
 * 实现路径（对抗性审核 B1）：ModelRuntime.completeSimple(model, {systemPrompt, messages})。
 * UserMessage 只需 {role, content, timestamp}（pi-ai 类型已核实）。
 * 适配说明：
 *  1) 返回对象携带 complete 方法（对齐 LlmFn 接口与调用方 llm.complete(...)）。
 *  2) toContext 产出 {role, content, timestamp} 结构消息；pi-ai Context.messages 声明为
 *     Message[]，但 runtime 仅按 {role, content} 结构消费，故在 completeSimple 边界做一次
 *     类型断言（v1 纯文本；assistant 消息 content 包为 [{type:"text",text}] 数组形态，对齐
 *     pi-ai AssistantMessage.content——真实 provider 按数组逐块迭代，字符串会被静默丢弃）。
 *  3) pi-ai Usage 字段为 input/output，而本层公共契约（LlmResult.usage）按 brief 用
 *     inputTokens/outputTokens——映射时兼容两种形状（先取 inputTokens，回退到 input）。
 */
export function createLlmFn(deps: {
  modelRouter: ModelRouter;
  logger?: unknown;
  /** 性能计量（SPEC L0-④）：llm 调用事件（token/calls/latency） */
  onMetric?: (m: { provider: string; model: string; durationMs: number; inputTokens: number; outputTokens: number }) => void;
}): LlmFn {
  return {
    async complete(messages, opts) {
      const model = deps.modelRouter.resolve(opts?.provider, opts?.model);
      const runtime = deps.modelRouter.getRuntime();
      const ctx = toContext(messages, opts?.tools) as Context;
      const start = Date.now();
      const result = await runtime.completeSimple(model, ctx, { signal: opts?.signal });
      const inputTokens = usageInput(result.usage ?? {});
      const outputTokens = usageOutput(result.usage ?? {});
      deps.onMetric?.({
        provider: model.provider,
        model: model.id,
        durationMs: Date.now() - start,
        inputTokens,
        outputTokens,
      });
      // 原生工具调用提取：AssistantMessage.content 含 ToolCall 块（OpenAI tool_calls 结构化）
      const toolCalls = Array.isArray(result.content)
        ? result.content
            .filter((b: unknown) => (b as { type?: string })?.type === "toolCall")
            .map((b: unknown) => {
              const t = b as { id: string; name: string; arguments?: unknown };
              return { id: t.id, name: t.name, arguments: (t.arguments ?? {}) as Record<string, unknown> };
            })
        : undefined;
      return {
        content: extractText(result.content),
        model: result.model,
        usage: result.usage
          ? {
              inputTokens: usageInput(result.usage),
              outputTokens: usageOutput(result.usage),
            }
          : undefined,
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      };
    },
  };
}

/** messages → pi Context 转换层（原生工具调用：tools 声明 + toolResult 消息回填） */
function toContext(messages: LlmMessage[], tools?: Tool[]): { systemPrompt?: string; messages: unknown[]; tools?: Tool[] } {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = messages.filter((m) => m.role !== "system");
  return {
    ...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n") } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    messages: rest.map((m) => ({
      ...(m.role === "tool"
        ? { role: "toolResult", toolCallId: m.toolCallId, toolName: m.toolName, content: [{ type: "text", text: m.content }] }
        : { role: m.role }),
      // assistant 消息 content 必须是 TextContent[] 数组形态（对齐 pi-ai AssistantMessage.content）：
      // 真实 provider（anthropic/google/openai）对 assistant 分支按 content 数组逐块迭代（block.type
      // 分流），字符串会被逐字符拆解导致空 blocks → 整条消息静默丢弃。user 分支兼容字符串。
      content: m.role === "assistant" || m.role === "tool" ? [{ type: "text", text: m.content }] : m.content,
      timestamp: Date.now(),
    })),
  };
}

/** pi-ai Usage 的输入 token 数（兼容 brief 测试形状 inputTokens 与真实形状 input） */
function usageInput(u: { input: number; inputTokens?: number }): number {
  return u.inputTokens ?? u.input;
}

/** pi-ai Usage 的输出 token 数（兼容 brief 测试形状 outputTokens 与真实形状 output） */
function usageOutput(u: { output: number; outputTokens?: number }): number {
  return u.outputTokens ?? u.output;
}

/** assistant content（TextContent[]）→ 拼接文本 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => typeof c === "object" && c !== null && "text" in c && typeof (c as any).text === "string")
      .map((c) => (c as any).text)
      .join("");
  }
  return String(content ?? "");
}
