/**
 * agent-loop —— LLM agent 执行循环（PTH 初衷恢复：任务 = 意图，LLM 主导执行）。
 *
 * 循环：LLM 每步输出 JSON 动作 → 工具表执行 → Observation 回填；done/maxSteps/超时终止。
 *
 * 复用：llm-fn（ModelRuntime——与 PTL/PTH provider 同源）、kernel 三件套（REPL 工具）、
 *   capability 白名单（web/state/fs/memory——与 vm 注入同一份）。
 * 自研原因（2026-08-08）：SDK createAgentSession 的 system prompt 不可定制（重建）且会加载本环境扩展。
 */
import type { LlmFn } from "../interpreter/llm-fn.js";
import type { WorkerKernel } from "../interpreter/index.js";
import type { WorkerRole } from "./worker-cluster.js";
import { AGENT_TOOLS, toolsToSchema, type AgentToolResult } from "./agent-tools.js";
import { EXEC_TOOL_CAP, normalizeToolName, toolsForSpace, ASP_BLOCK, buildAgentSystemPrompt } from "./agent-loop-prompt.js";
import type { AgentTaskInput, AgentLoopOptions, AgentTaskResult, AgentTraceEvent } from "./agent-loop-types.js";
export type { AgentTaskInput, AgentLoopOptions, AgentTaskResult, AgentTraceEvent } from "./agent-loop-types.js";
import { isTsFamily, truncate, actionFingerprint, type RecentAction, toolFamily, normalizePathPattern, actionTarget, isNegativeResult, negativeLoopCheck, buildEnvironmentPrelude, RECENT_RESULTS_WINDOW } from "./agent-loop-guards.js";
export { PTH_WORKER_SYSTEM, buildAgentSystemPrompt, filterCapabilityDoc } from "./agent-loop-prompt.js";
import { parseAgentAction, AGENT_CAPABILITY_AS_ACTION } from "./parse-agent-action.js";
import { config, configNumber } from "../extensions/perf-params.js";
import { pthConfig } from "../../config/index.js";
import { createGuardRegistry } from "./guardrails.js";
import { runPtcProgram } from "../ptc/runner.js";
import { modelState } from "../extensions/model.js";
import { spaceRegistry, isRoleBoundToSpace } from "./space-registry.js";

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_TIMEOUT_MS = 120_000;

/** 构建 agent system prompt：角色人设 + 工具协议 + 能力文档 + PTC 程序模式引导 + 输出要求 */
/** PTH Worker 世界观（2026-08-09——参考 pi 系统提示词/AGENTS.md 功能：身份/工作流/框架事实/约束）。
 * 固定注入（所有角色共享——buildAgentSystemPrompt 最前）——worker 知道自己在 PTH 框架。
 * 详细规则文档化（memory kind='pth-worker-system'——受保护——lazy 可查）。 */
async function runAgentTaskCore(input: AgentTaskInput & AgentLoopOptions): Promise<AgentTaskResult> {
  const { llm, kernel, caps } = input;
  // 参数走配置中心（Phase 2——perf.set 运行时生效；env 兜底）
  const maxSteps = input.maxSteps ?? configNumber("PTH_AGENT_MAX_STEPS", DEFAULT_MAX_STEPS);
  const timeoutMs = input.timeoutMs ?? configNumber("PTH_AGENT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  // ASP 模式（动作空间协议——过渡期旗标）：当前空间状态机
  const aspMode = input.asp === true;
  const aspSession = { currentSpace: "meta" };   // ASP：初始驻地 = 元空间
  if (input.sessionRef) input.sessionRef.current = aspSession;   // memory 可见性读取同一会话
  const currentSpace = () => aspSession.currentSpace;
  // 随身缓存（任务级行李——task-loop 注入或本函数自建）
  const cache: import("./cache-store.js").CacheStore = input.cache ?? new (await import("./cache-store.js")).CacheStore();
  let system = await buildAgentSystemPrompt(input.role, input.task.title, {
    // 2026-08-14 T2：仅显式 env 覆盖才传入——缺省交由角色类策略（规划系 eager/其余 lazy）
    mode: (() => {
      const m = pthConfig().str("PTH_AGENT_MODE");
      return (m === "lazy" || m === "eager" ? m : undefined) as "eager" | "lazy" | undefined;
    })(),
    // 2026-08-15 审计 MEDIUM：非 ASP 模式 prompt 工具面与 schema 同源（剔除 ASP-only）
    asp: aspMode,
    memory: (caps as { memory?: { query(sql: string): Promise<Array<{ content: string }>> } }).memory,
  });
  if (aspMode) system = `${system}\n\n${ASP_BLOCK}`;
  // 静态环境注入（②）：任务开始时拉环境预置（toolstore 文件 + 记忆概览）——LLM 一上来就知道可用资产
  const prelude = await buildEnvironmentPrelude(caps);

  // 消息策略（2026-08-09 架构修正——用户裁决：OpenAI 格式 API 用原生 tool_calls，
  // 不是文本 JSON 动作解析）：
  //   多轮消息：assistant 回复（含 ToolCall 意图）→ 执行 → toolResult 回填（toolCallId 关联）→
  //   模型在结构化工具调用与文本回复间二选一——不存在"输出大段代码导致 parse 失败"。
  //   单轮模式（旧——文本 JSON 动作）废弃；parseAgentAction 保留为 done 文本降级兼容。
  const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolName?: string; thinking?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }> = [
    { role: "system", content: system },
    { role: "user", content: `任务描述：${input.task.text}\n\n${prelude ? `环境预置：\n${prelude}\n\n` : ""}` },
  ];
  (input as { __messages?: unknown }).__messages = messages;   // 压缩包装器读取（同一引用——循环内持续 push）
  const staticTools = toolsToSchema(input.role?.actionTools, { asp: aspMode });

  // ── 工具面（2026-08-14 T3 裁决：废弃 pick_tools 动态注入——结构化动作空间+记忆空间
  //    已减少同时暴露的工具数；工具面 = 空间面 ∩ 角色白名单，不再动态收窄）──
  /** 当前轮 LLM 调用实际工具面 */
  function currentTools(aspCurrent: string): import("@earendil-works/pi-ai").Tool[] {
    const base = aspMode
      ? toolsForSpace(aspCurrent, input.role?.actionTools)
      : [...staticTools];
    // 同名工具去重（OpenAI 对重复工具名 400）
    return [...new Map(base.map((t) => [t.name, t])).values()];
  }

  const start = Date.now();
  let steps = 0;
  let lastFingerprint = "";
  let recentResults: RecentAction[] = [];  // 负结果收敛窗口（≤6 步——同工具族+同目标连续负结果 N=3 引导/N=15 终止——S6 死循环机制 2026-08-13；N=15 由 2026-08-15 D2 裁决）
  // 护栏注册表（2026-08-14 N12——阈值 PTH_GUARD_* 走配置中心、豁免矩阵声明式、处置语义统一 soft/hard）
  const guardReg = createGuardRegistry((k, d) => configNumber(k, d));
  const repeatGuard = guardReg.guard("repeat-action");
  const emptyDoneGuard = guardReg.guard("empty-done");
  const emptyReplyGuard = guardReg.guard("empty-reply");
  const unknownToolGuard = guardReg.guard("unknown-tool");

  const complete = async (tools: import("@earendil-works/pi-ai").Tool[]): Promise<import("../interpreter/llm-fn.js").LlmResult | string> => {
    try {
      // LLM 调用超时保护（实测修复 2026-08-09：deepseek-v4-flash 挂起 → 循环冻结——
      // 任务级超时检查在循环头，卡在 await 内永远到不了；单次调用 30s 兜底）
      const llmTimeoutMs = configNumber("PTH_AGENT_LLM_TIMEOUT_MS", 30_000);
      return await Promise.race([
        llm.complete(
          messages,
          {
            provider: "deepseek",
            model: input.role?.model ?? modelState.current?.model ?? config().get("PTH_AGENT_MODEL") ?? "deepseek-v4-flash",
            thinking: input.role?.thinking,   // Agent-JIT 路径 B：角色推理档 → reasoning_effort（scout low / 执行 high）
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

    // ASP：工具面随当前空间动态计算（语言工具仅本空间可调用）
    const tools = currentTools(currentSpace());
    const res = await complete(tools);
    if (typeof res === "string") {
      if (res.startsWith("__llm_error__")) {
        input.onTrace?.({ type: "finish", ok: false, steps: steps + 1, error: res.slice(14) });
        return { ok: false, error: res.slice(14), steps };
      }
      // LLM 直接文本回复（无工具调用）——视为完成（内容作为结果说明）
      return { ok: true, value: res || null, summary: res, steps: steps + 1 };
    }
    messages.push({ role: "assistant", content: res.content, ...(res.thinking ? { thinking: res.thinking } : {}), ...(res.toolCalls && res.toolCalls.length > 0 ? { toolCalls: res.toolCalls } : {}) });
    input.onTrace?.({ type: "llm-call", step: steps + 1, toolCalls: res.toolCalls, contentPreview: (res.content ?? "").slice(0, 500), ...((res as { thinking?: string }).thinking ? { thinking: (res as { thinking?: string }).thinking!.slice(0, 800) } : {}), ...(res.usage ? { usage: res.usage } : {}) });
    // 2026-08-15 审计 MEDIUM-2：空回复护栏只在"真空回复"时 hit——有工具调用/有文本就重置
    if ((res.toolCalls && res.toolCalls.length > 0) || (res.content && res.content.trim().length > 0)) {
      emptyReplyGuard.step({ roleId: input.role?.id, tool: "(empty-reply)", steps: steps + 1 }, false);
    }

    // 原生 tool_calls：结构化调用（OpenAI 格式——非文本解析）
    if (res.toolCalls && res.toolCalls.length > 0) {
      for (const tc of res.toolCalls) {
        const r = await executeStep({ tool: tc.name, args: tc.arguments, thought: undefined }, tc.id);
        if (r !== undefined) {
          // 序列完整性（2026-08-14 B1）：提前终止时，未回填的调用补合成 tool 消息——
          // 防止 assistant(tool_calls) 悬挂（DeepSeek v4 校验每个 tool_calls 必须有对应 tool 响应）
          for (const rest of res.toolCalls) {
            const key = rest.id ?? `tc-${steps + 1}`;
            if (!messages.some((m) => m.role === "tool" && m.toolCallId === key)) {
              messages.push({ role: "tool", toolCallId: key, toolName: rest.name, content: "[终止] 任务已提前结束——该调用未执行。" });
            }
          }
          return r;
        }
      }
      continue;
    }
    // 无工具调用但 assistant 有文本——完成
    if (res.content && res.content.trim().length > 0) {
      return { ok: true, value: res.content, summary: res.content, steps: steps + 1 };
    }
    // 空回复（deepseek-v4-flash 已知问题）——重试而非完成（连续 N 次判失败——N12 护栏）
    const ev = emptyReplyGuard.step({ roleId: input.role?.id, tool: "(empty-reply)", steps: steps + 1 }, true);
    if (ev.kind !== "none") input.onTrace?.({ type: "guard", step: steps + 1, guard: "empty-reply", kind: ev.kind, count: ev.count, limit: ev.limit });
    if (ev.kind === "hard") return { ok: false, error: "llm 连续空回复（无 tool_calls 无文本）", steps: steps + 1 };
    continue;
  }

  input.onTrace?.({ type: "finish", ok: true, steps, warning: `达到 maxSteps(${maxSteps}) 强制终止` });
  return { ok: true, value: null, steps, warning: `达到 maxSteps(${maxSteps}) 强制终止` };

  async function executeStep(action: { tool: string; args: Record<string, unknown>; thought?: string }, toolCallId?: string): Promise<AgentTaskResult | undefined> {
    // 2026-08-15 审计 LOW：别名/下划线归一提前到所有门控与护栏之前——
    // ASP 空间门控、execTool 授权、重复检测、执行器查表都按归一后名字判定。
    const rawTool = action.tool;
    const tool = normalizeToolName(rawTool);
    // 2026-08-15 审计 MEDIUM-4：provider 可能给 null/数组/字符串 arguments——统一对象化再分发
    const args: Record<string, unknown> =
      action.args && typeof action.args === "object" && !Array.isArray(action.args) ? action.args : {};
    // 重复检测（收敛 agent 行为 v1——轨迹分析 2026-08-09）：
    // 语义指纹（关键参数）连续相同 → 重复。≥3 次回填引导（不终止——模型修正策略）；
    // ≥5 次强制终止（防失控）。
    const fp = actionFingerprint(tool, args);
    const fpHit = fp === lastFingerprint;
    if (!fpHit) lastFingerprint = fp;
    const rv = repeatGuard.step({ roleId: input.role?.id, tool, steps: steps + 1 }, fpHit);
    if (rv.kind !== "none") input.onTrace?.({ type: "guard", step: steps + 1, guard: "repeat-action", kind: rv.kind, count: rv.count, limit: rv.limit });
    if (rv.kind === "soft") {
      return { ok: true, value: null, steps: steps + 1, warning: `连续 ${rv.count} 次重复动作（${tool}），强制终止` };
    }
    if (rv.kind === "guide" && isTsFamily(tool)) {
      // 引导：重复读同一文件无意义——回填提示让模型推进（结果已在历史 tool-result）
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
        content: `[收敛] 检测到重复动作（第 ${rv.count + 1} 次相同文件读取）——该文件内容已在前面的工具结果中返回过——不要重复读取，直接基于已有结果推进下一步（设计/实现/测试/完成）。` });
      input.logger?.(`[agent] step=${steps + 1} 重复动作引导（${fp.slice(0, 60)}）`);
      return undefined;
    }

    input.onTrace?.({ type: "tool-call", step: steps + 1, tool: rawTool, args });
    const stepStart = Date.now();

    // （2026-08-14 T3：pick_tools 动态工具选择协议已废弃移除——工具面不再动态收窄）
    // ── ASP 门控（asp 模式——空间状态机）────────────────────────────
    if (aspMode) {
      try {
      // 空间生成/注销已移出 worker 工具面（2026-08-14 N8——T6 裁决：空间生成走优化通道/审批面；
      // 治理通道入口 = spaceRegistry.createChild/unregister——asp.create/asp.destroy 工具已退役）
      if (tool === "asp.cd") {
        const target = String(args["space"] ?? "");
        const sp = spaceRegistry.get(target);
        if (!sp) {
          messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
            content: `asp_cd: 未知空间 "${target}"（已注册: ${spaceRegistry.list().map((s) => s.id).join("/")}）` });
          return undefined;
        }
        // 空间-角色绑定校验（2026-08-14 N8——生成即绑定）：绑定空间拒绝非绑定角色进入（谱系上溯匹配）
        const { allLineageRoles } = await import("./worker-cluster.js");
        if (!isRoleBoundToSpace(sp, input.role ? { id: input.role.id, parent: input.role.parent } : undefined, allLineageRoles())) {
          const bound = (sp.bindRoles ?? []).join("/");
          messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
            content: `asp_cd: 空间 "${target}" 绑定 worker 类型 ${bound}——本角色（${input.role?.id ?? "?"}）不可进入。asp.index 查看你可进入的空间（基板全角色共享，绑定空间仅绑定类型可进）。` });
          input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: 0, resultPreview: `绑定拒绝 → ${target}` });
          return undefined;
        }
        aspSession.currentSpace = target;
        const hint = target === "meta"
          ? "元空间：无执行核——可用 done 提交任务。"
          : `可用执行工具：${sp.execTool}（语言代码仅在本空间可解析）。`;
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
          content: `已迁移到 ${target} 空间。${hint}` });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: true, durationMs: 0, resultPreview: `cd → ${target}` });
        return undefined;
      }
      if (tool === "asp.index") {
        const { buildSpaceIndex } = await import("./space-index.js");
        const out = await buildSpaceIndex(
          { mode: typeof args["mode"] === "string" ? args["mode"] : undefined, space: typeof args["space"] === "string" ? args["space"] : undefined },
          { currentSpace: currentSpace(), kernel, caps },
        );
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: out });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: true, durationMs: 0, resultPreview: out.slice(0, 120) });
        return undefined;
      }
      if (tool === "memory.index") {
        const { buildMemoryIndex } = await import("@away_from/pth-memory");
        const memory = (caps as { memory?: { query(sql: string): Promise<unknown>; retrieve(o: never): Promise<never[]>; get(id: string): Promise<unknown> } }).memory;
        if (!memory) {
          messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: "memory 能力不可用（本角色无 memory 包）" });
          return undefined;
        }
        const out = await buildMemoryIndex(
          { tag: typeof args["tag"] === "string" ? args["tag"] : undefined, id: typeof args["id"] === "string" ? args["id"] : undefined },
          { memory: memory as never, currentSpace: currentSpace() },
        );
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: out });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: true, durationMs: 0, resultPreview: out.slice(0, 120) });
        return undefined;
      }
      if (tool === "cache.index") {
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: cache.index() });
        return undefined;
      }
      if (tool === "cache.cancel") {
        const key = String(args["key"] ?? "");
        const removed = cache.cancel(key);
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
          content: removed ? `已释放缓存条目 "${key}"。` : `cache.cancel: 键 "${key}" 不存在（cache.index 查看当前条目）` });
        return undefined;
      }
      if (tool === "cache.load") {
        const memory = (caps as { memory?: { get(id: string): Promise<{ content: string } | undefined>; retrieve(o: never): Promise<Array<{ id: string; content: string }>> } }).memory;
        const push = (key: string, content: string, source: string) => {
          const r = cache.load(key, content, source);
          return r.ok ? `✓ ${key}（${content.length}c）` : `✗ ${key}：${r.reason}`;
        };
        const results: string[] = [];
        if (typeof args["key"] === "string" && typeof args["content"] === "string") {
          results.push(push(String(args["key"]), String(args["content"]), "custom"));
        } else if (memory) {
          const ids: string[] = Array.isArray(args["ids"]) ? (args["ids"] as unknown[]).map(String) : typeof args["id"] === "string" ? [String(args["id"])] : [];
          if (ids.length > 0) {
            for (const id of ids) {
              const e = await memory.get(id);
              results.push(e ? push(id, e.content, `memory:${id}`) : `✗ ${id}：条目不存在`);
            }
          } else if (typeof args["tag"] === "string") {
            const entries = await memory.retrieve({ anchors: [String(args["tag"])] } as never);
            for (const e of entries.slice(0, 10)) results.push(push(e.id, e.content, `memory:${e.id}`));
            if (entries.length === 0) results.push(`tag "${args["tag"]}" 无可见条目`);
          } else {
            results.push("cache.load: 需要 {id}/{ids}/{tag}（从记忆空间）或 {key, content}（自定义）");
          }
        } else {
          results.push("memory 能力不可用——仅支持 {key, content} 自定义载入");
        }
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
          content: `cache.load：\n${results.join("\n")}\n${cache.index().split("\n")[0]}` });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: true, durationMs: 0, resultPreview: results.join("; ").slice(0, 120) });
        return undefined;
      }
      // 语言执行工具仅在本空间可解析（下划线形工具名 → 空间反查；
      // 2026-08-14 N8：绑定空间继承基板工具族——同族多空间以当前空间族归属判定）
      const requiredSpace = spaceRegistry.spaceOfExecTool(tool);
      if (requiredSpace && currentSpace() !== requiredSpace && !spaceRegistry.spaceOwnsTool(currentSpace(), tool)) {
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
          content: `[ASP] 当前位于 ${currentSpace()} 空间——${tool} 不可在此解析执行。先 asp_cd("${requiredSpace}")。` });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: 0, resultPreview: `空间门控：需 ${requiredSpace}` });
        return undefined;
      }
      if (tool === "done" && currentSpace() !== "meta") {
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
          content: `[ASP] done 仅在元空间可用（当前 ${currentSpace()}）——先 asp_cd("meta") 再提交。` });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: 0, resultPreview: "done 门控：需 meta" });
        return undefined;
      }
      } catch (e) {
        // 2026-08-15 审计 MEDIUM：ASP 内联工具（asp_index/memory_index/cache_*）异常回填而非打崩任务
        const detail = `step ${steps + 1} [${tool}]: 工具异常 ${(e as Error).message}`;
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: detail });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: Date.now() - stepStart, resultPreview: detail.slice(0, 200) });
        input.logger?.(`[agent] step=${steps + 1} tool=${tool} error=${(e as Error).message}`);
        return undefined;
      }
    }

    if (tool === "done") {
      const result = args["result"];
      // 空产物判定：undefined/null/空对象/空数组/空字符串——都视为未提交实际产物（0/false 等合法 falsy 不误伤）
      const isEmptyResult =
        result === undefined || result === null ||
        (typeof result === "object" && !Array.isArray(result) && Object.keys(result).length === 0) ||
        (Array.isArray(result) && result.length === 0) ||
        (typeof result === "string" && result.trim().length === 0);
      if (isEmptyResult) {
        // 收尾引导（L2 运行时引导——不再立即 reject——回填引导让模型重新提交正确产物）
        const dv = emptyDoneGuard.step({ roleId: input.role?.id, tool, steps: steps + 1 }, true);
        input.onTrace?.({ type: "guard", step: steps + 1, guard: "empty-done", kind: dv.kind === "hard" ? "hard" : "hit", count: dv.count, limit: dv.limit });
        const guide = result === undefined || result === null
          ? "done 缺少 result（必填）——已拒绝：你的 done 调用未携带最终产出对象。请重新调用 done：result 必须为实际产物（实现代码/写入的文件/计算结果等任意 JSON），可附带 summary 说明完成情况。"
          : "done 的 result 为空（无实际产物内容）——已拒绝：空对象/空数组/空字符串不构成产物。请重新调用 done：result 必须为实际产物（实现代码/写入的文件/计算结果等任意 JSON），可附带 summary 说明完成情况。";
        const remaining = dv.limit - dv.count;
        messages.push({
          role: "tool",
          toolCallId: toolCallId ?? `tc-${steps + 1}`,
          toolName: tool,
          content: `step ${steps + 1} [done]: ${guide}（第 ${dv.count} 次空 done——剩余 ${remaining} 次机会，之后将强制终止）`,
        });
        input.logger?.(`[agent] step=${steps + 1} done 空 result 引导（第 ${dv.count}/${dv.limit} 次）`);
        input.onStep?.({ n: steps + 1, tool, durationMs: Date.now() - stepStart, ok: false, args: JSON.stringify(args).slice(0, 300) });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: Date.now() - stepStart, resultPreview: guide.slice(0, 200) });
        if (dv.kind === "hard") {
          return { ok: false, error: `done 连续 ${dv.count} 次缺少 result（应携带实际产物）——已按失败终止`, steps: steps + 1 };
        }
        return undefined;  // 继续循环——模型看到引导后应重新调用 done 提交正确产物
      }
      // 2026-08-15 审计 MEDIUM-2：空 done 护栏只在真空 done 时 hit——有效 done 重置计数
      emptyDoneGuard.step({ roleId: input.role?.id, tool, steps: steps + 1 }, false);
      const summary = typeof args["summary"] === "string" ? args["summary"] : undefined;
      input.onStep?.({ n: steps + 1, tool, durationMs: Date.now() - stepStart, ok: true });
      // finish trace（task.done 活动事件源——trigger 引擎/console --follow 的完成信号——之前断链只在失败路径发）
      input.onTrace?.({ type: "finish", ok: true, steps: steps + 1, valuePreview: JSON.stringify(result).slice(0, 200) });
      return { ok: true, value: result, summary, steps: steps + 1 };
    }

    // tool_calls 名已在 executeStep 入口归一（下划线→点 + 直觉别名）——直接查执行器表
    const executorKey = tool;
    const executor = AGENT_TOOLS[executorKey as keyof typeof AGENT_TOOLS];
    if (!executor) {
      // 能力函数被当动作工具输出（收敛兼容）：自动降级为 ts 程序执行。
      // 2026-08-12 审计 LOW-11 修复：下划线形（memory_query）同样降级——归一后查表
      const wrap = AGENT_CAPABILITY_AS_ACTION[tool] ?? AGENT_CAPABILITY_AS_ACTION[tool.replace(/_/g, ".")];
      if (wrap) {
        const code = wrap(args);
        input.logger?.(`[agent] step=${steps + 1} capability-action ${tool} → ts 程序降级`);
        // PTC 统一执行缝（2026-08-14 A1 Phase 2——执行+注册收敛进 ptc/runner；
        // Phase 3 条目 12——任务级 caps 装配随缝注入）
        const { raw } = await runPtcProgram({
          code, cwd: "/tmp", ts: kernel.ts, caps: input.capabilityInject,
          registerResult: { key: `result_${steps + 1}`, build: (r) => ({ tool, ok: r.ok, value: r.ok ? r.value : undefined, error: r.ok ? undefined : r.error }) },
        });
        const result: AgentToolResult = raw.ok
          ? { ok: true, value: raw.value, stdout: truncate(JSON.stringify(raw.value ?? null), 2000).text }
          : { ok: false, error: raw.error?.message ?? "ts execute failed" };
        input.onStep?.({ n: steps + 1, tool, durationMs: Date.now() - stepStart, ok: result.ok, args: JSON.stringify(args).slice(0, 300) });
        const summary = result.ok
          ? (result.stdout ?? JSON.stringify(result.value ?? null)).slice(0, 500)
          : `error: ${result.error ?? "unknown"}`;
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: `step ${steps + 1} [${tool}]: ${summary}` });
        return undefined;
      }
      // 未知工具回填引导（2026-08-13：不再直接失败——给模型纠错机会——
      // 模型幻觉工具名（write_doc）时引导正确工具名——连续 N 次才终止（N12 护栏））
      const uv = unknownToolGuard.step({ roleId: input.role?.id, tool, steps: steps + 1 }, true);
      input.onTrace?.({ type: "guard", step: steps + 1, guard: "unknown-tool", kind: uv.kind === "hard" ? "hard" : "hit", count: uv.count, limit: uv.limit });
      const knownNames = Object.keys(AGENT_TOOLS).filter((n) => n !== "done");
      const hint = knownNames.slice(0, 12).join("/");
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
        content: `未知工具 ${tool}（第 ${uv.count} 次）——可用工具如: ${hint}… 请用已注册工具名重试（下划线形也可）。` });
      input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: 0, resultPreview: `未知工具引导 ${tool}` });
      if (uv.kind === "hard") return { ok: false, error: `未知工具 ${tool}（连续 ${uv.count} 次）`, steps: steps + 1 };
      return undefined;
    }
    // 2026-08-15 审计 MEDIUM-2：工具已知且到达执行面——unknown-tool 护栏重置（非连续才不累积）
    unknownToolGuard.step({ roleId: input.role?.id, tool, steps: steps + 1 }, false);
    // 执行面角色授权（模块级 EXEC_TOOL_CAP——见顶部定义）
    const execFam = executorKey.split(".")[0];
    const needCaps = EXEC_TOOL_CAP[execFam];
    const roleCaps = input.role?.capabilities;
    if (needCaps && roleCaps && !needCaps.some((c) => (roleCaps as string[]).includes(c))) {
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
        content: `[授权] ${tool} 拒绝：本角色 capabilities 未含 ${needCaps.join("/")}（能力面声明了白名单——执行面按白名单门控）。` });
      input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: 0, resultPreview: "capabilities 授权拒绝" });
      return undefined;
    }
    try {
      const result = await executor(
        { kernel, caps, taskWorkspace: input.taskWorkspace, toolstore: input.toolstore, space: aspMode ? aspSession.currentSpace : undefined, ptcCaps: input.capabilityInject },
        args,
      );
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
          : `error: ${result.error ?? (result.stderr?.trim() ? result.stderr : "unknown")}`;
      // 负结果收敛窗口（S6 死循环机制——2026-08-13）：同工具族+同目标连续负结果
      // N=3 回填引导（该路径已确认不可用→换策略）、N=15 强制终止（2026-08-15 D2：5→15）
      const neg = isNegativeResult(result);
      const fam = toolFamily(tool);
      const tgt = actionTarget(tool, args);
      recentResults.push({ family: fam, target: tgt, neg });
      const negLimits = guardReg.negativeLimits();
      // 窗口下限 6，动态扩展至 ≥ 终止阈值 + 1（否则 N=15 时 6 步窗口永远计不满 15）
      const keepWindow = Math.max(RECENT_RESULTS_WINDOW, negLimits.terminate + 1);
      while (recentResults.length > keepWindow) recentResults.shift();
      // 2026-08-14 T5 侦察豁免进豁免矩阵（N12）——guardReg.exempt("negative-loop") 声明式判定
      const reconExempt = guardReg.exempt("negative-loop", { roleId: input.role?.id, tool, steps: steps + 1 });
      const loopCheck = negativeLoopCheck(recentResults, fam, tgt, neg, !reconExempt, negLimits.terminate, negLimits.guideAt);
      if (loopCheck.action !== "none") {
        input.onTrace?.({ type: "guard", step: steps + 1, guard: "negative-loop", kind: loopCheck.action === "terminate" ? "soft" : "guide", count: loopCheck.count, limit: negLimits.terminate });
      }
      // 2026-08-15 审计 MEDIUM-1：引导与真实结果必须合并进同一条 tool 消息——
      // 同一 toolCallId 两条 tool 消息会被 llm-fn first-wins 去重，引导从未到达模型
      const guideSuffix = loopCheck.action === "guide"
        ? `\n[收敛] 检测到连续 ${loopCheck.count} 次负结果（${fam} · ${tgt}）——该路径已确认不可用——不要继续探测/重试同一目标——换策略（优先查 capability-index/ext-registry 权威列表，替代盲探测）。`
        : "";
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: `step ${steps + 1} [${tool}]: ${summary}${result.truncated ? " (truncated)" : ""}${guideSuffix}` });
      input.logger?.(`[agent] step=${steps + 1} tool=${tool} ok=${result.ok} args=${JSON.stringify(args).slice(0, 300)}`);
      input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: result.ok, durationMs: Date.now() - stepStart, resultPreview: summary.slice(0, 500) });
      if (loopCheck.action === "terminate") {
        return { ok: true, value: null, steps: steps + 1, warning: `连续 ${loopCheck.count} 次负结果（${fam} · ${tgt}）——负验证循环，强制终止` };
      }
      if (loopCheck.action === "guide") {
        input.logger?.(`[agent] step=${steps + 1} 负结果引导（${fam} · ${tgt} ×${loopCheck.count}）`);
        return undefined;
      }
      return undefined;  // 继续循环
    } catch (e) {
      // 工具执行异常（参数错误等）→ 回填错误让 LLM 修正（不算失败）
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: `step ${steps + 1} [${tool}]: 工具异常 ${(e as Error).message}` });
      input.logger?.(`[agent] step=${steps + 1} tool=${tool} error=${(e as Error).message}`);
      return undefined;
    }
  }
}

/**
 * runAgentTask（压缩包装——2026-08-10）：内核执行 + 结束压缩（CoT 模板）。
 * 认知模型：压缩是必备功能（提前实现）；评估读取压缩产物。done/失败都压缩
 * （失败的思维过程对评估价值更高）。压缩失败不阻断任务结果。
 */
export async function runAgentTask(input: AgentTaskInput & AgentLoopOptions): Promise<AgentTaskResult> {
  const result = await runAgentTaskCore(input);
  try {
    const messages = (input as { __messages?: Array<import("./context-compaction.js").CompactableMessage> }).__messages;
    if (messages && messages.length >= 4) {
      const { compressContext, COT_TEMPLATE } = await import("./context-compaction.js");
      result.compression = await compressContext(
        { llm: input.llm },
        { messages, template: COT_TEMPLATE, taskTitle: input.task.title },
      );
    }
  } catch { /* 压缩失败容忍——任务结果为主 */ }
  return result;
}
