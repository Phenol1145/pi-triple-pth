/**
 * ptc-agent-loop.ts —— PTC 迭代执行模式（Wave 5）。
 *
 * 每轮 LLM 输出 JSON：
 *   { "done": false, "program": "async function main(){ ... }", "reason": "..." }
 *   { "done": true, "finalResult": <value> }
 *
 * 协议：
 *  - done=false 必须带 program；
 *  - done=true 无 program 时用 prior result 或 finalResult；
 *  - done=true 带 program 视为协议错误；
 *  - 首轮 done=true 必须带 finalResult；
 *  - JSON/协议失败有独立修订预算（缺省 3），不占 PTH_PTC_MAX_ITERATIONS。
 */

import type { LlmFn } from "@away_from/pth-kernel-interpreter";
import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";
import { runPtcProgram, config, configNumber } from "@away_from/pth-kernel-interpreter";
import { TASK_AWAIT_SUSPENDED_CODE } from "@away_from/pth-contracts";
import type { AgentTraceEvent } from "./agent-loop-types.js";

const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_MAX_PROTOCOL_FAILURES = 3;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface PtcAgentLoopOptions {
  llm: LlmFn;
  kernel: WorkerKernel;
  task: { title: string; text: string };
  goal?: string;
  publisherClarification?: string;
  taskWorkspace?: string;
  capabilityInject?: Record<string, unknown>;
  logger?: (msg: string) => void;
  onTrace?: (event: AgentTraceEvent) => void;
  maxIterations?: number;
  maxProtocolFailures?: number;
  model?: string;
  timeoutMs?: number;
}

export type PtcAgentTaskResult =
  | {
      ok: true;
      value: unknown;
      summary?: string;
      steps: number;
      warning?: string;
      /** TASK_AWAIT_SUSPENDED_CODE 挂起信号（runner 转 retryable requeue） */
      code?: string;
    }
  | { ok: false; error: string; code?: string; steps: number };

interface PtcTurnJson {
  done?: unknown;
  program?: unknown;
  reason?: unknown;
  finalResult?: unknown;
}

function parsePtcTurn(raw: string): { ok: true; value: PtcTurnJson } | { ok: false; error: string } {
  let text = String(raw ?? "").trim();
  // 容忍 markdown code fence
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1]!.trim();
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: "PTC 输出必须是 JSON 对象" };
    }
    return { ok: true, value: value as PtcTurnJson };
  } catch {
    return { ok: false, error: "PTC JSON 解析失败" };
  }
}

function validatePtcTurn(
  turn: PtcTurnJson,
  first: boolean,
  hasPrior: boolean,
): { ok: true; done: boolean; program?: string; reason?: string; finalResult?: unknown } | { ok: false; error: string } {
  const done = turn.done;
  if (typeof done !== "boolean") return { ok: false, error: "PTC done 必须是 boolean" };
  if (done) {
    if (turn.program !== undefined && turn.program !== null) {
      return { ok: false, error: "PTC done=true 时不得携带 program（协议错误）" };
    }
    if (first && turn.finalResult === undefined) {
      return { ok: false, error: "PTC 首轮 done=true 必须提供 finalResult" };
    }
    return {
      ok: true,
      done: true,
      reason: typeof turn.reason === "string" ? turn.reason : undefined,
      finalResult: turn.finalResult,
    };
  }
  if (typeof turn.program !== "string" || turn.program.trim() === "") {
    return { ok: false, error: "PTC done=false 必须提供非空 program" };
  }
  return {
    ok: true,
    done: false,
    program: turn.program,
    reason: typeof turn.reason === "string" ? turn.reason : undefined,
  };
}

function buildSystemPrompt(input: PtcAgentLoopOptions): string {
  const lines = [
    "你是 PTH 迭代式 TS 程序执行器。你的任务是把自然语言任务拆成可执行的 TypeScript 程序，并逐轮修订直到完成。",
    "",
    "每轮只输出一个 JSON 对象，不要输出其他文本：",
    '  {"done": false, "program": "async function main(){ ... }", "reason": "本轮说明"}',
    '  {"done": true, "finalResult": <最终产物>, "reason": "完成说明"}',
    "",
    "规则：",
    "- done=false 时必须提供非空 program（async function main）；",
    "- done=true 时不得携带 program；首轮 done=true 必须携带 finalResult；",
    "- 程序执行结果会回填给你，下一轮基于结果修订；",
    "- 达到轮数上限仍未 done 会被软终止。",
  ];
  if (input.goal?.trim()) lines.push("", `【根目标】${input.goal.trim()}`);
  if (input.publisherClarification?.trim()) lines.push("", `【发布者澄清】${input.publisherClarification.trim()}`);
  return lines.join("\n");
}

export async function runPtcAgentTask(input: PtcAgentLoopOptions): Promise<PtcAgentTaskResult> {
  const maxIterations = input.maxIterations ?? configNumber("PTH_PTC_MAX_ITERATIONS", DEFAULT_MAX_ITERATIONS);
  const maxProtocolFailures = input.maxProtocolFailures ?? DEFAULT_MAX_PROTOCOL_FAILURES;
  const timeoutMs = input.timeoutMs ?? configNumber("PTH_PTC_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const model = input.model ?? config().get("PTH_PTC_MODEL") ?? "deepseek-v4-flash";

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: buildSystemPrompt(input) },
    { role: "user", content: `任务标题：${input.task.title}\n任务描述：${input.task.text}` },
  ];

  let protocolFailures = 0;
  let priorValue: unknown;
  let hasPrior = false;
  const start = Date.now();

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (Date.now() - start > timeoutMs) {
      return { ok: true, value: priorValue, steps: iteration - 1, warning: `ptc-timeout: 超过 ${timeoutMs}ms` };
    }
    let llmText: string;
    try {
      const res = await Promise.race([
        input.llm.complete(messages, {
          provider: "deepseek",
          model,
          thinking: "off",
          timeoutMs: 30_000,
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("llm-timeout")), 30_000)),
      ]);
      if (typeof res === "string") throw new Error(res);
      llmText = res.content ?? "";
    } catch (e) {
      return { ok: false, error: `ptc-llm-error: ${(e as Error).message}`, steps: iteration - 1 };
    }

    const parsed = parsePtcTurn(llmText);
    if (!parsed.ok) {
      protocolFailures++;
      input.onTrace?.({ type: "ptc-result", step: iteration, iteration, ok: false, error: parsed.error, durationMs: 0 });
      if (protocolFailures >= maxProtocolFailures) {
        return { ok: false, error: `ptc-protocol-failed: ${parsed.error}（连续 ${protocolFailures} 次）`, steps: iteration - 1 };
      }
      messages.push({ role: "assistant", content: llmText });
      messages.push({ role: "user", content: `[协议错误 ${protocolFailures}/${maxProtocolFailures}] ${parsed.error}。请只输出合法 JSON。` });
      continue;
    }
    const validated = validatePtcTurn(parsed.value, !hasPrior, hasPrior);
    if (!validated.ok) {
      protocolFailures++;
      input.onTrace?.({ type: "ptc-result", step: iteration, iteration, ok: false, error: validated.error, durationMs: 0 });
      if (protocolFailures >= maxProtocolFailures) {
        return { ok: false, error: `ptc-protocol-failed: ${validated.error}（连续 ${protocolFailures} 次）`, steps: iteration - 1 };
      }
      messages.push({ role: "assistant", content: llmText });
      messages.push({ role: "user", content: `[协议错误 ${protocolFailures}/${maxProtocolFailures}] ${validated.error}。请只输出合法 JSON。` });
      continue;
    }

    if (validated.done) {
      const value = validated.finalResult !== undefined ? validated.finalResult : priorValue;
      input.onTrace?.({ type: "finish", ok: true, steps: iteration, valuePreview: JSON.stringify(value).slice(0, 200) });
      return { ok: true, value, summary: validated.reason, steps: iteration };
    }

    const program = validated.program!;
    input.onTrace?.({ type: "ptc-program", step: iteration, iteration, program, reason: validated.reason });
    const { raw } = await runPtcProgram({
      code: program,
      cwd: input.taskWorkspace ?? "/tmp",
      ts: input.kernel.ts,
      caps: input.capabilityInject,
    });
    const durationMs = raw.durationMs ?? 0;
    input.onTrace?.({
      type: "ptc-result",
      step: iteration,
      iteration,
      ok: raw.ok,
      ...(raw.ok
        ? { valuePreview: JSON.stringify(raw.value ?? null).slice(0, 200), stdoutPreview: (raw.stdout ?? "").slice(0, 200) }
        : { error: raw.error?.message ?? "unknown", errorCode: raw.error?.code, errorClass: "execution" }),
      durationMs,
    });

    if (!raw.ok && raw.error?.code === TASK_AWAIT_SUSPENDED_CODE) {
      input.onTrace?.({ type: "finish", ok: true, steps: iteration, warning: raw.error.message });
      return { ok: true, value: null, steps: iteration, warning: raw.error.message, code: TASK_AWAIT_SUSPENDED_CODE };
    }

    if (!raw.ok) {
      messages.push({ role: "assistant", content: llmText });
      messages.push({ role: "user", content: `[执行失败 iteration=${iteration}] ${raw.error?.message ?? "unknown"}。请修订程序。` });
      continue;
    }

    priorValue = raw.value;
    hasPrior = true;
    messages.push({ role: "assistant", content: llmText });
    messages.push({ role: "user", content: `[执行成功 iteration=${iteration}] 结果：${JSON.stringify(raw.value ?? null).slice(0, 1000)}。若任务完成请输出 done=true。` });
  }

  input.onTrace?.({ type: "finish", ok: true, steps: maxIterations, warning: `ptc-max-iterations: 达到 ${maxIterations} 轮仍未 done` });
  return { ok: true, value: priorValue, steps: maxIterations, warning: `ptc-max-iterations: 达到 ${maxIterations} 轮仍未 done` };
}
