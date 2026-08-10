import type { Context, Tool } from "@earendil-works/pi-ai";
import type { ModelRouter } from "@away_from/infra";

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
  /** 推理内容（reasoning_content——deepseek 思考字段——轨迹分析用） */
  thinking?: string;
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
  depsMetric = deps.onMetric ?? null;
  // 测试钩子（PTH_LLM_STUB=1）：集成测试无 LLM 凭据——agent 循环立即 done 完成 /
  // 转译路径返回合法 TS。任务池纯化后 e2e 链路（fork batch）必须经 LLM——stub 是唯一隔离缝。
  if (process.env.PTH_LLM_STUB === "1") {
    return {
      async complete(_messages, opts) {
        if (opts?.tools && opts.tools.length > 0) {
          return { content: "", model: "stub", toolCalls: [{ id: "stub-call", name: "done", arguments: { result: "stub-done" } }] };
        }
        return { content: "return { stub: true }", model: "stub" };
      },
    };
  }
  return {
    async complete(messages, opts) {
      const model = deps.modelRouter.resolve(opts?.provider, opts?.model);
      // 原生工具调用（OpenAI tool_calls——2026-08-09 架构修正）：
      // pi-ai completeSimple 兼容层对 tools 场景有缺陷（官方 deepseek 返回空）——
      // tools 存在时直连 provider chat/completions（OpenAI 兼容——结构化 tool_calls）
      if (opts?.tools && opts.tools.length > 0) {
        return directOpenAiComplete(model, messages, opts);
      }
      const runtime = deps.modelRouter.getRuntime();
      const ctx = toContext(messages) as Context;
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

/** OpenAI 兼容直连（原生 tool_calls——绕过 pi-ai completeSimple） */
async function directOpenAiComplete(
  model: { baseUrl?: string; id: string; provider: string },
  messages: LlmMessage[],
  opts?: LlmCompleteOptions,
): Promise<LlmResult> {
  const baseUrl = model.baseUrl ?? "https://api.deepseek.com";
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error(`directComplete: ${model.provider} 无 API key（DEEPSEEK_API_KEY/OPENAI_API_KEY env）`);

  // 消息转换（OpenAI 格式）：system 并入首条；tool 角色 → tool 消息（tool_call_id）
  const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const apiMessages: Array<Record<string, unknown>> = [];
  if (systemText) apiMessages.push({ role: "system", content: systemText });
  for (const m of messages.filter((x) => x.role !== "system")) {
    if (m.role === "tool") {
      apiMessages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else if (m.role === "assistant") {
      const tc = (m as { toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }).toolCalls;
      apiMessages.push({
        role: "assistant",
        content: m.content,
        ...(tc && tc.length > 0
          ? { tool_calls: tc.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) } })) }
          : {}),
      });
    } else {
      apiMessages.push({ role: "user", content: m.content });
    }
  }

  const tools = (opts?.tools ?? []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 60_000);
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model.id, messages: apiMessages, tools, stream: false }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`directComplete ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const msg = json.choices?.[0]?.message as {
    content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    reasoning_content?: string | null;
  } | undefined;
  const toolCalls = (msg?.tool_calls ?? []).map((tc) => {
    try { return { id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments) as Record<string, unknown> }; }
    catch { return { id: tc.id, name: tc.function.name, arguments: {} }; }
  });
  if (depsMetric) depsMetric({ provider: String(model.provider), model: model.id, durationMs: Date.now() - start, inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 });
  return {
    content: msg?.content ?? "",
    model: model.id,
    usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(msg?.reasoning_content ? { thinking: msg.reasoning_content } : {}),
  };
}

// direct 路径计量：模块级 depsMetric（createLlmFn 构造时注入——onMetric 同源）
let depsMetric: ((m: { provider: string; model: string; durationMs: number; inputTokens: number; outputTokens: number }) => void) | null = null;
