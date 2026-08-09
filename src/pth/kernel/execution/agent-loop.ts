/**
 * agent-loop —— LLM agent 执行循环（PTH 初衷恢复：任务 = 意图，LLM 主导执行）。
 *
 * 循环：LLM 每步输出 JSON 动作（parse-agent-action 解析）→ 工具表执行（agent-tools）
 *   → Observation 回填 → 下一步；done 终止；maxSteps/超时强制终止。
 *
 * 复用：llm-fn（ModelRuntime——与 PTL/PTH provider 同源）、kernel 三件套（REPL 工具）、
 *   capability 白名单（web/state/fs/memory——与 vm 注入同一份）。
 * 自研原因（spike 结论 2026-08-08）：SDK createAgentSession 的 system prompt 不可定制
 *   （prompt 时重建）且加载本环境扩展（place_bid 等）——任务执行需要受控环境。
 */
import type { LlmFn } from "../interpreter/llm-fn.js";
import type { WorkerKernel } from "../interpreter/index.js";
import type { WorkerRole } from "./worker-cluster.js";
import { AGENT_TOOLS, AGENT_TOOLS_DESCRIPTION, AGENT_CAPABILITY_DOC, toolsToSchema, type AgentToolResult } from "./agent-tools.js";
import { parseAgentAction, AGENT_CAPABILITY_AS_ACTION } from "./parse-agent-action.js";
import { config, configNumber } from "../extensions/perf-params.js";
import { modelState } from "../extensions/model.js";

export interface AgentTaskInput {
  task: { title: string; text: string };
  /** 任务工作区（fs.task 落盘——ts 工具 cwd） */
  taskWorkspace?: string;
  role?: WorkerRole;
}

export interface AgentLoopOptions {
  llm: LlmFn;
  kernel: WorkerKernel;
  /** capability 白名单（web/state/fs/memory）——与 vm 注入同一份 */
  caps: Record<string, unknown>;
  maxSteps?: number;
  timeoutMs?: number;
  logger?: (msg: string) => void;
  onStep?: (step: { n: number; tool: string; durationMs: number; ok: boolean; args?: string }) => void;
  /** 运行过程保留（2026-08-09）：轨迹事件流——task-loop 收集写 transcript（审计/复现/续跑） */
  onTrace?: (event: AgentTraceEvent) => void;
}

/** 运行过程轨迹事件（结构化——transcript body 事件数组） */
export type AgentTraceEvent =
  | { type: "llm-call"; step: number; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; contentPreview: string }
  | { type: "tool-call"; step: number; tool: string; args: Record<string, unknown> }
  | { type: "tool-result"; step: number; tool: string; ok: boolean; durationMs: number; resultPreview: string }
  | { type: "finish"; ok: boolean; steps: number; error?: string; warning?: string; valuePreview?: string };

export type AgentTaskResult =
  | { ok: true; value: unknown; summary?: string; steps: number; warning?: string }
  | { ok: false; error: string; steps: number };

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_TIMEOUT_MS = 120_000;

/** 构建 agent system prompt：角色人设 + 工具协议 + 能力文档 + PTC 程序模式引导 + 输出要求 */
/** Prompt 框架（2026-08-09：Prompt 文档化——统一模板 + eager/lazy 渲染参数）。
 * 数据源：memory（role-doc:<role> / capability-index——injectPromptDocs 注入）。
 * eager：渲染层 query 读全文注入；lazy：指针（LLM 按需 memory.query——与 memory 检索同构）。
 * 新核/新角色：更新 memory 文档——模板零改动。 */
export async function buildAgentSystemPrompt(
  role: WorkerRole | undefined,
  taskTitle: string,
  opts: { mode?: "eager" | "lazy" | "auto"; memory?: { query(sql: string): Promise<Array<{ content: string }>> } } = {},
): Promise<string> {
  // 模式：auto 按模型智力（v1 简化：env PTH_AGENT_MODE 覆盖；auto 缺省 eager——后续按模型映射）
  const mode = opts.mode ?? (process.env.PTH_AGENT_MODE === "lazy" ? "lazy" : "eager");

  // 角色块：eager = 角色文档全文（memory query）；lazy = 指针
  let roleBlock = "";
  if (role) {
    if (mode === "lazy") {
      roleBlock = `你的角色：${role.id}。角色文档在 memory（kind='role-doc:${role.id}'）——
先用 memory.query 查询它了解你的职责与工作方式：
SELECT content FROM memory_entries WHERE kind='role-doc:${role.id}' LIMIT 1\n（若查询不到——按人设执行：${role.prompt.slice(0, 120)}）`;
    } else {
      try {
        const rows = opts.memory ? await opts.memory.query(`SELECT content FROM memory_entries WHERE kind='role-doc:${role.id}' LIMIT 1`) : [];
        roleBlock = rows[0]?.content ?? role.prompt;
      } catch {
        roleBlock = role.prompt;
      }
    }
  }

  // 能力块：eager = 能力索引全文；lazy = 指针
  let capBlock = "";
  if (mode === "lazy") {
    capBlock = `【能力探索（按需读取）】
ts 程序内可调用能力函数——完整清单在 memory（kind='capability-index'）：
const idx = await memory.query("SELECT content FROM memory_entries WHERE kind='capability-index' LIMIT 1");\n（或用 fs.readText 读 toolstore 文件）——需要什么能力先查索引——不要盲试。
源码阅读：fs.readSource（读索引可知用法）。任务工作区写入：fs.task（读索引可知）。`;
  } else {
    try {
      const rows = opts.memory ? await opts.memory.query("SELECT content FROM memory_entries WHERE kind='capability-index' LIMIT 1") : [];
      capBlock = rows[0]?.content ?? AGENT_CAPABILITY_DOC;
    } catch {
      capBlock = AGENT_CAPABILITY_DOC;
    }
  }

  return `你是任务执行 agent。
当前任务：${taskTitle}

${roleBlock}

${AGENT_TOOLS_DESCRIPTION}

${capBlock}

【API 调查技能】（当你不清楚执行核预定义函数/对象（fs/memory/llm/context 等）的构成、参数、语法或返回值时）
const skill = await memory.query("SELECT content FROM memory_entries WHERE kind='skill:api-investigation' LIMIT 1");
（按文档方法调查——Object.keys/fn.toString/读实现源码/试错推断——不要盲试）

【程序模式（PTC——优先使用）】
优先用 ts 工具写【完整程序】一次性组合多个 kernel/能力完成多步，而不是分步发多个动作：
- ts 程序运行在 vm 沙箱，可 await 调用能力函数；程序内可写 for/if/函数/变量——跨步骤传值
- 结果自动注册 results 对象（results.result_1 引用之前步骤的工具输出）
- context 对象跨步骤保留（context.my_key = ... 供后续程序读取）
- return 的值 + 程序 stdout 都会回填给你（中间输出可见）
单 kernel 简单步骤（python.execute / bash.execute）可直接调用；复杂多步组合用 ts 程序。

输出要求：每步输出一个 JSON 动作（可用工具在 tools 声明中——结构化 tool_calls）。
完成任务时输出 done 工具（args.result = 最终产出对象，args.summary = 完成说明）。
如果任务无法完成（信息不足/超出能力），也用 done 提交并说明原因。`;
}

function truncate(s: string, max = 2000): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + `…(截断 ${s.length - max} 字符)`, truncated: true };
}

/** 动作指纹（防死锁/重复：连续相同动作检测）
 * 归一化：ts 工具提取关键调用（fs.readSource/readText 路径）——同路径=重复
 * （轨迹分析 2026-08-09：模型 14 次微变重写同一 readSource——全量 args 比较被微小
 *   变量名/注释差异绕过——语义指纹按关键参数判定重复） */
function actionFingerprint(tool: string, args: Record<string, unknown>): string {
  if (tool === "ts" && typeof args.code === "string") {
    // 提取关键文件读取调用（readSource/readText 的路径）——忽略变量名/注释等无关差异
    const reads = [...args.code.matchAll(/fs\.(readSource|readText)\(\s*"([^"]+)"/g)]
      .map((m) => `${m[1]}:${m[2]}`)
      .sort();
    if (reads.length > 0) return `ts:${reads.join(",")}`;
    // 无文件读取——退化为工具名（同工具连续即重复候选）
    return `ts:*`;
  }
  return `${tool}:${JSON.stringify(args)}`;
}

/** 静态环境注入：toolstore 文件清单 + 记忆概览（失败容忍——不阻断任务） */
async function buildEnvironmentPrelude(caps: Record<string, unknown>): Promise<string> {
  const parts: string[] = [];
  try {
    const fs = caps["fs"] as { list?(dir?: string): Promise<unknown> } | undefined;
    if (fs?.list) {
      const files = await fs.list();
      const text = JSON.stringify(files);
      if (text && text !== "[]") parts.push(`toolstore 文件: ${text.slice(0, 1000)}`);
    }
  } catch { /* 无 toolstore 容忍 */ }
  try {
    const memory = caps["memory"] as { query?(sql: string): Promise<unknown> } | undefined;
    if (memory?.query) {
      const rows = await memory.query("SELECT kind, count(*) AS n FROM memory_entries GROUP BY kind ORDER BY n DESC LIMIT 10");
      const text = JSON.stringify(rows);
      if (text && text !== "[]") parts.push(`记忆概览: ${text.slice(0, 1000)}`);
    }
  } catch { /* 记忆不可用容忍 */ }
  return parts.join("\n");
}

export async function runAgentTask(input: AgentTaskInput & AgentLoopOptions): Promise<AgentTaskResult> {
  const { llm, kernel, caps } = input;
  // 参数走配置中心（Phase 2——perf.set 运行时生效；env 兜底）
  const maxSteps = input.maxSteps ?? configNumber("PTH_AGENT_MAX_STEPS", DEFAULT_MAX_STEPS);
  const timeoutMs = input.timeoutMs ?? configNumber("PTH_AGENT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const system = await buildAgentSystemPrompt(input.role, input.task.title, {
    mode: (process.env.PTH_AGENT_MODE === "lazy" || process.env.PTH_AGENT_MODE === "eager" ? process.env.PTH_AGENT_MODE : "eager") as "eager" | "lazy",
    memory: (caps as { memory?: { query(sql: string): Promise<Array<{ content: string }>> } }).memory,
  });
  // 静态环境注入（②）：任务开始时拉环境预置（toolstore 文件 + 记忆概览）——LLM 一上来就知道可用资产
  const prelude = await buildEnvironmentPrelude(caps);

  // 消息策略（2026-08-09 架构修正——用户裁决：OpenAI 格式 API 用原生 tool_calls，
  // 不是文本 JSON 动作解析）：
  //   多轮消息：assistant 回复（含 ToolCall 意图）→ 执行 → toolResult 回填（toolCallId 关联）→
  //   模型在结构化工具调用与文本回复间二选一——不存在"输出大段代码导致 parse 失败"。
  //   单轮模式（旧——文本 JSON 动作）废弃；parseAgentAction 保留为 done 文本降级兼容。
  const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolName?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }> = [
    { role: "system", content: system },
    { role: "user", content: `任务描述：${input.task.text}\n\n${prelude ? `环境预置：\n${prelude}\n\n` : ""}` },
  ];
  const tools = toolsToSchema();

  const start = Date.now();
  let steps = 0;
  let lastFingerprint = "";
  let repeatCount = 0;
  let emptyReplies = 0;

  const complete = async (): Promise<import("../interpreter/llm-fn.js").LlmResult | string> => {
    try {
      // LLM 调用超时保护（实测修复 2026-08-09：deepseek-v4-flash 挂起 → 循环冻结——
      // 任务级超时检查在循环头，卡在 await 内永远到不了；单次调用 30s 兜底）
      const llmTimeoutMs = configNumber("PTH_AGENT_LLM_TIMEOUT_MS", 30_000);
      return await Promise.race([
        llm.complete(
          messages,
          {
            provider: "deepseek",
            model: modelState.current?.model ?? config().get("PTH_AGENT_MODEL") ?? "deepseek-v4-flash",
            timeoutMs: llmTimeoutMs,
            tools,
          },
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`llm-timeout after ${llmTimeoutMs}ms`)), llmTimeoutMs)),
      ]);
    } catch (e) {
      return `__llm_error__:${(e as Error).message}`;
    }
  };

  for (; steps < maxSteps; steps++) {
    if (Date.now() - start > timeoutMs) {
      return { ok: false, error: `agent-timeout: 超过 ${timeoutMs}ms`, steps };
    }

    const res = await complete();
    if (typeof res === "string") {
      if (res.startsWith("__llm_error__")) {
        input.onTrace?.({ type: "finish", ok: false, steps: steps + 1, error: res.slice(14) });
        return { ok: false, error: res.slice(14), steps };
      }
      // LLM 直接文本回复（无工具调用）——视为完成（内容作为结果说明）
      return { ok: true, value: res || null, summary: res, steps: steps + 1 };
    }
    messages.push({ role: "assistant", content: res.content, ...(res.toolCalls && res.toolCalls.length > 0 ? { toolCalls: res.toolCalls } : {}) });
    input.onTrace?.({ type: "llm-call", step: steps + 1, toolCalls: res.toolCalls, contentPreview: (res.content ?? "").slice(0, 500) });

    // 原生 tool_calls：结构化调用（OpenAI 格式——非文本解析）
    if (res.toolCalls && res.toolCalls.length > 0) {
      for (const tc of res.toolCalls) {
        const r = await executeStep({ tool: tc.name, args: tc.arguments, thought: undefined }, tc.id);
        if (r !== undefined) return r;
      }
      continue;
    }
    // 无工具调用但 assistant 有文本——完成
    if (res.content && res.content.trim().length > 0) {
      return { ok: true, value: res.content, summary: res.content, steps: steps + 1 };
    }
    // 空回复（deepseek-v4-flash 已知问题）——重试而非完成（连续 3 次判失败）
    emptyReplies += 1;
    if (emptyReplies >= 3) return { ok: false, error: "llm 连续空回复（无 tool_calls 无文本）", steps: steps + 1 };
    continue;
  }

  return { ok: true, value: null, steps, warning: `达到 maxSteps(${maxSteps}) 强制终止` };

  async function executeStep(action: { tool: string; args: Record<string, unknown>; thought?: string }, toolCallId?: string): Promise<AgentTaskResult | undefined> {
    const { tool, args } = action;
    // 重复检测（收敛 agent 行为 v1——轨迹分析 2026-08-09）：
    // 语义指纹（关键参数）连续相同 → 重复。≥3 次回填引导（不终止——模型修正策略）；
    // ≥5 次强制终止（防失控）。
    const fp = actionFingerprint(tool, args);
    if (fp === lastFingerprint) repeatCount++;
    else { lastFingerprint = fp; repeatCount = 0; }
    if (repeatCount >= 5) {
      return { ok: true, value: null, steps: steps + 1, warning: `连续 ${repeatCount} 次重复动作（${tool}），强制终止` };
    }
    if (repeatCount >= 3 && tool === "ts") {
      // 引导：重复读同一文件无意义——回填提示让模型推进（结果已在历史 tool-result）
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
        content: `[收敛] 检测到重复动作（第 ${repeatCount + 1} 次相同文件读取）——该文件内容已在前面的工具结果中返回过——不要重复读取，直接基于已有结果推进下一步（设计/实现/测试/完成）。` });
      input.logger?.(`[agent] step=${steps + 1} 重复动作引导（${fp.slice(0, 60)}）`);
      return undefined;
    }

    input.onTrace?.({ type: "tool-call", step: steps + 1, tool, args });
    const stepStart = Date.now();
    if (tool === "done") {
      const result = args["result"];
      if (result === undefined || result === null) {
        return { ok: false, error: "done 缺少 result", steps: steps + 1 };
      }
      const summary = typeof args["summary"] === "string" ? args["summary"] : undefined;
      input.onStep?.({ n: steps + 1, tool, durationMs: Date.now() - stepStart, ok: true });
      return { ok: true, value: result, summary, steps: steps + 1 };
    }

    // tool_calls 名是 API 形式（下划线——python_execute）——映射回执行器（点）
    const executorKey = tool.replace(/_/g, ".");
    const executor = AGENT_TOOLS[executorKey as keyof typeof AGENT_TOOLS];
    if (!executor) {
      // 能力函数被当动作工具输出（收敛兼容）：自动降级为 ts 程序执行
      const wrap = AGENT_CAPABILITY_AS_ACTION[tool];
      if (wrap) {
        const code = wrap(args);
        input.logger?.(`[agent] step=${steps + 1} capability-action ${tool} → ts 程序降级`);
        const r = await kernel.ts.execute(code, { cwd: "/tmp" });
        const result: AgentToolResult = r.ok
          ? { ok: true, value: r.value, stdout: truncate(JSON.stringify(r.value ?? null), 2000).text }
          : { ok: false, error: r.error?.message ?? "ts execute failed" };
        input.onStep?.({ n: steps + 1, tool, durationMs: Date.now() - stepStart, ok: result.ok, args: JSON.stringify(args).slice(0, 300) });
        try {
          kernel.ts.registerResult?.(`result_${steps + 1}`, { tool, ok: result.ok, value: result.ok ? result.value : undefined, error: result.ok ? undefined : result.error });
        } catch { /* mock 容忍 */ }
        const summary = result.ok
          ? (result.stdout ?? JSON.stringify(result.value ?? null)).slice(0, 500)
          : `error: ${result.error ?? "unknown"}`;
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: `step ${steps + 1} [${tool}]: ${summary}` });
        return undefined;
      }
      return { ok: false, error: `未知工具 ${tool}`, steps: steps + 1 };
    }
    try {
      const result = await executor({ kernel, caps, taskWorkspace: input.taskWorkspace }, args);
      input.onStep?.({ n: steps + 1, tool, durationMs: Date.now() - stepStart, ok: result.ok, args: JSON.stringify(args).slice(0, 300) });
      // 结果注册表（ts 核内 results 对象——用户裁决）：每步工具结果自动注册供程序引用
      const resultKey = `result_${steps + 1}`;
      try {
        kernel.ts.registerResult?.(resultKey, {
          tool,
          ok: result.ok,
          value: result.ok ? result.value : undefined,
          stdout: (result.stdout ?? "").slice(0, 2000),
          error: result.ok ? undefined : result.error,
        });
      } catch {
        /* 注册失败不阻断（mock kernel 无 registerResult） */
      }
      // 轨迹摘要（截断防膨胀）
      const summary = result.quiet
        ? "[quiet] 静默执行（无输出）"
        : result.ok
          ? (result.stdout ?? JSON.stringify(result.value ?? null)).slice(0, 500)
          : `error: ${result.error ?? "unknown"}`;
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: `step ${steps + 1} [${tool}]: ${summary}${result.truncated ? " (truncated)" : ""}` });
      input.logger?.(`[agent] step=${steps + 1} tool=${tool} ok=${result.ok} args=${JSON.stringify(args).slice(0, 300)}`);
      input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: result.ok, durationMs: Date.now() - stepStart, resultPreview: summary.slice(0, 500) });
      return undefined;  // 继续循环
    } catch (e) {
      // 工具执行异常（参数错误等）→ 回填错误让 LLM 修正（不算失败）
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: `step ${steps + 1} [${tool}]: 工具异常 ${(e as Error).message}` });
      input.logger?.(`[agent] step=${steps + 1} tool=${tool} error=${(e as Error).message}`);
      return undefined;
    }
  }
}
