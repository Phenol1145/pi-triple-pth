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
import { AGENT_TOOLS, AGENT_TOOLS_DESCRIPTION, AGENT_CAPABILITY_DOC, type AgentToolResult } from "./agent-tools.js";
import { parseAgentAction, AGENT_CAPABILITY_AS_ACTION } from "./parse-agent-action.js";

export interface AgentTaskInput {
  task: { title: string; text: string };
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
  onStep?: (step: { n: number; tool: string; durationMs: number; ok: boolean }) => void;
}

export type AgentTaskResult =
  | { ok: true; value: unknown; summary?: string; steps: number; warning?: string }
  | { ok: false; error: string; steps: number };

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_TIMEOUT_MS = 120_000;

/** 构建 agent system prompt：角色人设 + 工具协议 + 能力文档 + PTC 程序模式引导 + 输出要求 */
export function buildAgentSystemPrompt(role: WorkerRole | undefined, taskTitle: string): string {
  return `你是任务执行 agent${role ? `（${role.prompt}）` : ""}。
当前任务：${taskTitle}

${AGENT_TOOLS_DESCRIPTION}

${AGENT_CAPABILITY_DOC}

【程序模式（PTC——优先使用）】
优先用 ts 工具写【完整程序】一次性组合多个 kernel/能力完成多步，而不是分步发多个动作：
- ts 程序运行在 vm 沙箱，可 await 调用能力函数；程序内可写 for/if/函数/变量——跨步骤传值
- 结果自动注册 results 对象（results.result_1 引用之前步骤的工具输出）
- context 对象跨步骤保留（context.my_key = ... 供后续程序读取）
- 例：{"action":{"tool":"ts","args":{"code":"const py = await python.execute(\"_result = sum(range(1,101))\\\n\"); const b = await bash.execute(\"echo \" + py.value + \" | grep -q . && echo ok\"); return { sum: py.value, verified: b.stdout.includes('ok') };"}}}
- return 的值 + 程序 stdout 都会回填给你（中间输出可见）
单 kernel 简单步骤（python.execute / bash.execute）可直接调用；复杂多步组合用 ts 程序。

输出要求：每步只输出一个 JSON 对象（可带 brief 思考），不要输出 JSON 以外的多余内容。
完成任务时输出 {"action":{"tool":"done","args":{"result":<最终产出对象>,"summary":"完成说明"}}}。
如果任务无法完成（信息不足/超出能力），也用 done 提交并说明原因。`;
}

function truncate(s: string, max = 2000): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + `…(截断 ${s.length - max} 字符)`, truncated: true };
}

/** 动作指纹（防死锁：连续相同动作强制终止） */
function actionFingerprint(tool: string, args: Record<string, unknown>): string {
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
  const maxSteps = input.maxSteps ?? Number(process.env.PTH_AGENT_MAX_STEPS ?? DEFAULT_MAX_STEPS);
  const timeoutMs = input.timeoutMs ?? Number(process.env.PTH_AGENT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const system = buildAgentSystemPrompt(input.role, input.task.title);
  // 静态环境注入（②）：任务开始时拉环境预置（toolstore 文件 + 记忆概览）——LLM 一上来就知道可用资产
  const prelude = await buildEnvironmentPrelude(caps);

  // 消息策略（实测发现 2026-08-08）：deepseek-v4-flash（qwen-token-plan-cn 代理）对
  // system+user+assistant+user 多轮序列返回空 content——agent 循环改为单轮模式：
  // 不回放 assistant 消息，工具结果轨迹并入 user（每步重建），模型稳定输出 JSON 动作。
  const toolTrail: string[] = [];

  const start = Date.now();
  let steps = 0;
  let lastFingerprint = "";
  let repeatCount = 0;

  const complete = async (): Promise<string> => {
    const userContent = `任务描述：${input.task.text}\n\n${prelude ? `环境预置：\n${prelude}\n\n` : ""}${toolTrail.length > 0 ? `执行记录：\n${toolTrail.join("\n")}\n\n` : ""}请输出下一个 JSON 动作（完成则输出 done）。`;
    try {
      const res = await llm.complete(
        [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
        {
          provider: "deepseek",
          model: process.env.PTH_AGENT_MODEL ?? "deepseek-v4-flash",
        },
      );
      return res.content;
    } catch (e) {
      return `__llm_error__:${(e as Error).message}`;
    }
  };

  for (; steps < maxSteps; steps++) {
    if (Date.now() - start > timeoutMs) {
      return { ok: false, error: `agent-timeout: 超过 ${timeoutMs}ms`, steps };
    }

    const raw = await complete();
    if (raw.startsWith("__llm_error__")) {
      return { ok: false, error: raw.slice(14), steps };
    }

    const parsed = parseAgentAction(raw);
    if (!parsed.ok) {
      // 容错：重试一次（PTH_AGENT_RETRY_PARSE 默认 1）
      const retry = Number(process.env.PTH_AGENT_RETRY_PARSE ?? 1);
      if (retry > 0) {
        const raw2 = await complete();
        const parsed2 = parseAgentAction(raw2);
        if (!parsed2.ok) return { ok: false, error: parsed2.error, steps };
        const r2 = await executeStep(parsed2.action);
        if (r2 !== undefined) return r2;
        continue;
      }
      return { ok: false, error: parsed.error, steps };
    }
    const r = await executeStep(parsed.action);
    if (r !== undefined) return r;
  }

  return { ok: true, value: null, steps, warning: `达到 maxSteps(${maxSteps}) 强制终止` };

  async function executeStep(action: { tool: string; args: Record<string, unknown>; thought?: string }): Promise<AgentTaskResult | undefined> {
    const { tool, args } = action;
    // 死锁检测：连续相同动作
    const fp = actionFingerprint(tool, args);
    if (fp === lastFingerprint) repeatCount++;
    else { lastFingerprint = fp; repeatCount = 0; }
    if (repeatCount >= 3) {
      return { ok: true, value: null, steps: steps + 1, warning: `连续 ${repeatCount} 次相同动作（${tool}），强制终止` };
    }

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

    const executor = AGENT_TOOLS[tool as keyof typeof AGENT_TOOLS];
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
        input.onStep?.({ n: steps + 1, tool, durationMs: Date.now() - stepStart, ok: result.ok });
        try {
          kernel.ts.registerResult?.(`result_${steps + 1}`, { tool, ok: result.ok, value: result.ok ? result.value : undefined, error: result.ok ? undefined : result.error });
        } catch { /* mock 容忍 */ }
        const summary = result.ok
          ? (result.stdout ?? JSON.stringify(result.value ?? null)).slice(0, 500)
          : `error: ${result.error ?? "unknown"}`;
        toolTrail.push(`step ${steps + 1} [${tool}]: ${summary}`);
        return undefined;
      }
      return { ok: false, error: `未知工具 ${tool}`, steps: steps + 1 };
    }
    try {
      const result = await executor({ kernel, caps }, args);
      input.onStep?.({ n: steps + 1, tool, durationMs: Date.now() - stepStart, ok: result.ok });
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
      toolTrail.push(`step ${steps + 1} [${tool}]: ${summary}${result.truncated ? " (truncated)" : ""}`);
      input.logger?.(`[agent] step=${steps + 1} tool=${tool} ok=${result.ok}`);
      return undefined;  // 继续循环
    } catch (e) {
      // 工具执行异常（参数错误等）→ 回填错误让 LLM 修正（不算失败）
      toolTrail.push(`step ${steps + 1} [${tool}]: 工具异常 ${(e as Error).message}`);
      input.logger?.(`[agent] step=${steps + 1} tool=${tool} error=${(e as Error).message}`);
      return undefined;
    }
  }
}
