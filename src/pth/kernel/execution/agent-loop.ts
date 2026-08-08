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
import { AGENT_TOOLS, AGENT_TOOLS_DESCRIPTION } from "./agent-tools.js";
import { parseAgentAction } from "./parse-agent-action.js";

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

/** 构建 agent system prompt：角色人设 + 工具协议 + 输出要求 */
export function buildAgentSystemPrompt(role: WorkerRole | undefined, taskTitle: string): string {
  return `你是任务执行 agent${role ? `（${role.prompt}）` : ""}。
当前任务：${taskTitle}

${AGENT_TOOLS_DESCRIPTION}

输出要求：每步只输出一个 JSON 对象（可带 brief 思考），不要输出 JSON 以外的多余内容。
完成任务时输出 {"action":{"tool":"done","args":{"result":<最终产出对象>,"summary":"完成说明"}}}。
如果任务无法完成（信息不足/超出能力），也用 done 提交并说明原因。`;
}

/** 动作指纹（防死锁：连续相同动作强制终止） */
function actionFingerprint(tool: string, args: Record<string, unknown>): string {
  return `${tool}:${JSON.stringify(args)}`;
}

export async function runAgentTask(input: AgentTaskInput & AgentLoopOptions): Promise<AgentTaskResult> {
  const { llm, kernel, caps } = input;
  const maxSteps = input.maxSteps ?? Number(process.env.PTH_AGENT_MAX_STEPS ?? DEFAULT_MAX_STEPS);
  const timeoutMs = input.timeoutMs ?? Number(process.env.PTH_AGENT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const system = buildAgentSystemPrompt(input.role, input.task.title);

  // 消息策略（实测发现 2026-08-08）：deepseek-v4-flash（qwen-token-plan-cn 代理）对
  // system+user+assistant+user 多轮序列返回空 content——agent 循环改为单轮模式：
  // 不回放 assistant 消息，工具结果轨迹并入 user（每步重建），模型稳定输出 JSON 动作。
  const toolTrail: string[] = [];

  const start = Date.now();
  let steps = 0;
  let lastFingerprint = "";
  let repeatCount = 0;

  const complete = async (): Promise<string> => {
    const userContent = `任务描述：${input.task.text}\n\n${toolTrail.length > 0 ? `执行记录：\n${toolTrail.join("\n")}\n\n` : ""}请输出下一个 JSON 动作（完成则输出 done）。`;
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
      return { ok: false, error: `未知工具 ${tool}`, steps: steps + 1 };
    }
    try {
      const result = await executor({ kernel, caps }, args);
      input.onStep?.({ n: steps + 1, tool, durationMs: Date.now() - stepStart, ok: result.ok });
      // 轨迹摘要（截断防膨胀）
      const summary = result.ok
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
