/**
 * agent-loop-registry-execution.ts —— Tool-Reg 注册工具执行接线段（模块专项：自 agent-loop.ts 抽出）。
 *
 * 封装：adapter 拒绝/授权 → CommandGateway decideRequest/decide → UnifiedExecutionDispatcher
 * 执行 → program/agent 态执行缝。主循环只保留分发调用。
 */
import type { ToolRegSpec } from "@away_from/pth-memory";
import { runPtcProgram } from "@away_from/pth-kernel-interpreter";
import { TASK_AWAIT_SUSPENDED_CODE } from "@away_from/pth-contracts";
import { truncate } from "./agent-loop-guards.js";
import type { AgentTaskResult, AgentTaskInput, AgentLoopOptions } from "./agent-loop-types.js";
import type { AgentToolResult } from "./agent-tools.js";
import { emitToolStep, toolStepSummary, type AgentLoopMessage } from "./agent-loop-step.js";

export interface RegistryExecutionContext {
  input: AgentTaskInput & AgentLoopOptions;
  tool: string;
  args: Record<string, unknown>;
  regSpec: ToolRegSpec;
  messages: AgentLoopMessage[];
  steps: number;
  toolCallId?: string;
  stepStart: number;
}

/** 注册工具执行缝：Command 层优先，其次 program/agent 态。返回 undefined 表示继续循环。 */
export async function executeRegisteredTool(ctx: RegistryExecutionContext): Promise<AgentTaskResult | undefined> {
  const { input, tool, args, regSpec, messages, steps, toolCallId, stepStart } = ctx;

  // Wave 2：Tool-Reg v2 command adapter 优先。
  // adapter 只返回 ExecutionRequest/deny；授权继续走 CommandGateway（decideRequest）。
  let adapterAuthorized = false;
  if (regSpec.command && input.adapterRegistry) {
    const adapterResult = input.adapterRegistry.call(regSpec.command, args ?? {});
    if (adapterResult.kind === "deny") {
      const feedback = adapterResult.feedback;
      const preview = feedback ? `${feedback.class}:${feedback.code}` : "adapter denied";
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
        content: `[adapter] ${tool} 拒绝：${adapterResult.reason}` });
      input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: Date.now() - stepStart, resultPreview: preview, ...(feedback ? { feedback, errorClass: feedback.class, errorCode: feedback.code, retryable: feedback.retryable } : {}) });
      return undefined;
    }
    if (input.commandGateway?.decideRequest && input.commandContext) {
      const decision = await input.commandGateway.decideRequest(adapterResult.request, input.commandContext);
      if (decision.kind === "deny") {
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
          content: `[授权] ${tool} 拒绝：${decision.reason}` });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: Date.now() - stepStart, resultPreview: "CommandGateway 拒绝", ...(decision.feedback ? { feedback: decision.feedback, errorClass: decision.feedback.class, errorCode: decision.feedback.code, retryable: decision.feedback.retryable } : {}) });
        return undefined;
      }
      if (decision.kind === "await-approval") {
        input.onTrace?.({ type: "finish", ok: true, steps: steps + 1, warning: "HUMAN_APPROVAL_PENDING" });
        return { ok: true, value: null, steps: steps + 1, humanApproval: { requestId: decision.requestId } };
      }
      if (decision.kind === "execute") {
        adapterAuthorized = true;
        if (input.executionDispatcher) {
          const execResult = await input.executionDispatcher.execute(decision.command);
          const feedback = execResult.ok
            ? undefined
            : {
                layer: "execute" as const,
                class: "execution" as const,
                code: execResult.error?.code ?? "EXECUTION_FAILED",
                message: execResult.error?.message ?? "execution failed",
                retryable: false,
                adapterId: regSpec.command,
                execKind: adapterResult.request.kind,
                target: decision.command.target ?? undefined,
                errorClass: execResult.error?.code,
                errorCode: execResult.error?.code,
                durationMs: execResult.durationMs,
              };
          const result: AgentToolResult = {
            ok: execResult.ok,
            ...(execResult.value !== undefined ? { value: execResult.value } : {}),
            ...(execResult.stdout !== undefined ? { stdout: execResult.stdout } : {}),
            ...(execResult.stderr !== undefined ? { stderr: execResult.stderr } : {}),
            ...(execResult.error ? { error: execResult.error.message, code: execResult.error.code } : {}),
            ...(execResult.truncated ? { truncated: true } : {}),
            ...(feedback ? { feedback } : {}),
            durationMs: execResult.durationMs,
          };
          // W8 P2：tasks.await 挂起信号 → 软终止释放认领（retryable requeue）
          if (!result.ok && result.code === TASK_AWAIT_SUSPENDED_CODE) {
            input.onTrace?.({ type: "finish", ok: true, steps: steps + 1, warning: result.error });
            return { ok: true, value: null, steps: steps + 1, warning: result.error ?? TASK_AWAIT_SUSPENDED_CODE };
          }
          emitToolStep({ input, messages, tool, args: args ?? {}, result, steps, toolCallId, durationMs: execResult.durationMs });
          input.onTrace?.({
            type: "tool-result",
            step: steps + 1,
            tool,
            ok: result.ok,
            durationMs: execResult.durationMs,
            resultPreview: toolStepSummary(result).slice(0, 500),
            ...(regSpec.command ? { adapterId: regSpec.command } : {}),
            execKind: adapterResult.request.kind,
            ...(decision.command.target ? { target: decision.command.target } : {}),
            ...(feedback ? { feedback, errorClass: feedback.class, errorCode: feedback.code, retryable: feedback.retryable } : {}),
          });
          return undefined;
        }
      }
    }
  }
  // TCE P3：tool-reg program/agent 执行缝先过 Command 层门控（收编 governance hole）。
  if (input.commandGateway && input.commandContext && !adapterAuthorized) {
    const decision = await input.commandGateway.decide({
      surface: "agent-tool",
      toolCall: { tool, args: args ?? {} },
      ctx: input.commandContext,
    });
    if (decision.kind === "deny") {
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
        content: `[授权] ${tool} 拒绝：${decision.reason}` });
      input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: Date.now() - stepStart, resultPreview: "CommandGateway 拒绝" });
      return undefined;
    }
    if (decision.kind === "await-approval") {
      input.onTrace?.({ type: "finish", ok: true, steps: steps + 1, warning: "HUMAN_APPROVAL_PENDING" });
      return { ok: true, value: null, steps: steps + 1, humanApproval: { requestId: decision.requestId } };
    }
  }
  const regExec = regSpec.executor;
  if (regExec.type === "program") {
    // program 态：固化 ts 程序（无 LLM）——args 注入为 const 绑定，源程序 return 值即结果
    const code = `const args = ${JSON.stringify(args ?? {})};\n${regExec.source}`;
    input.logger?.(`[agent] step=${steps + 1} tool-reg program ${regSpec.name}（tool:${regSpec.name}@v${regSpec.version}）`);
    const { raw } = await runPtcProgram({
      code, cwd: input.taskWorkspace ?? "/tmp", ts: input.kernel.ts, caps: input.capabilityInject,
      registerResult: { key: `result_${steps + 1}`, build: (r) => ({ tool, ok: r.ok, value: r.ok ? r.value : undefined, error: r.ok ? undefined : r.error }) },
    });
    // W8 P2 同款：tasks.await 挂起信号 → 软终止（value=null + warning）
    if (!raw.ok && raw.error?.code === TASK_AWAIT_SUSPENDED_CODE) {
      input.onTrace?.({ type: "finish", ok: true, steps: steps + 1, warning: raw.error.message });
      return { ok: true, value: null, steps: steps + 1, warning: raw.error.message };
    }
    const result: AgentToolResult = raw.ok
      ? { ok: true, value: raw.value, stdout: truncate(JSON.stringify(raw.value ?? null), 2000).text }
      : { ok: false, error: raw.error?.message ?? "tool-reg program 执行失败" };
    emitToolStep({ input, messages, tool, args: args ?? {}, result, steps, toolCallId, durationMs: Date.now() - stepStart });
    return undefined;
  }
  // agent 态：穿透 runChild 同款缝（深度限 1——子 kernel 不注入穿透/投递端口）
  if (regExec.type !== "agent") {
    // builtin 态 ref 未解析（asp-inline:* 等）——执行面不走注册通道（防御：正常路径已在上方归并）
    messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
      content: `tool-reg builtin ${regSpec.name} 的执行器引用 ${regExec.ref} 不在 AGENT_TOOLS 表（ASP 内联工具请切到对应空间后直接调用）` });
    input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: 0, resultPreview: "builtin ref 未解析" });
    return undefined;
  }
  const exec = input.toolRegExec;
  if (!exec?.runChild || !exec.caller) {
    messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
      content: `tool-reg agent 态执行缝未装配（toolRegExec.runChild/caller 缺失）——${regSpec.name} 暂不可调用` });
    input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: 0, resultPreview: "agent 态执行缝未装配" });
    return undefined;
  }
  const text = [
    `【注册工具调用】tool:${regSpec.name}（agent 态——子 agent ${regExec.role}）`,
    "",
    "【调用参数】",
    JSON.stringify(args ?? {}, null, 2),
  ].join("\n");
  input.logger?.(`[agent] step=${steps + 1} tool-reg agent ${regSpec.name} → ${regExec.role}`);
  const r = await exec.runChild({
    childRoleId: regExec.role,
    title: `tool:${regSpec.name}`,
    text,
    inputContract: regExec.input ?? "（未声明——调用参数 JSON 自描述）",
    outputContract: regExec.output ?? "（未声明——done.result 即产物）",
    skillId: `tool:${regSpec.name}`,
    caller: exec.caller,
  });
  const result: AgentToolResult = r.ok
    ? { ok: true, value: r.value, stdout: truncate(JSON.stringify(r.value ?? null), 2000).text }
    : { ok: false, error: r.error ?? "tool-reg agent 执行失败" };
  emitToolStep({ input, messages, tool, args: args ?? {}, result, steps, toolCallId, durationMs: Date.now() - stepStart });
  return undefined;
}
