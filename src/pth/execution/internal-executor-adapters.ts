/**
 * execution/internal-executor-adapters.ts —— TCE Phase 4：把存量 AGENT_TOOLS 工具体适配为
 * internal executor（行为不变，只搬管线）。dev/write/debug 族先迁；nav 属 ASP 内联暂不在此。
 */
import { AGENT_TOOLS, type AgentToolCtx, type AgentToolResult } from "@away_from/pth-kernel-execution";
import type { ExecutionResult } from "@away_from/pth-kernel-execution";
import type { InternalExecutorRegistry } from "./internal-executor-registry.js";

const DEV_WRITE_DEBUG_TOOLS = [
  "dev.write", "dev.edit", "dev.build", "dev.run", "dev.save", "dev.list",
  "write.create", "write.edit", "write.read", "write.list", "write.save", "write.section",
  "debug.attach", "debug.breakpoint", "debug.continue", "debug.step", "debug.snapshot",
  "debug.evaluate", "debug.detach", "debug.sessions",
] as const;

function agentToolResultToExecutionResult(r: AgentToolResult): ExecutionResult {
  return {
    ok: r.ok,
    ...(r.value !== undefined ? { value: r.value } : {}),
    ...(r.stdout !== undefined ? { stdout: r.stdout } : {}),
    ...(r.stderr !== undefined ? { stderr: r.stderr } : {}),
    ...(r.error !== undefined ? { error: { message: r.error, ...(r.code ? { code: r.code } : {}) } } : {}),
    durationMs: 0,
    ...(r.truncated !== undefined ? { truncated: true } : {}),
  };
}

/** 把单个 AGENT_TOOLS 工具适配为 internal executor（context 由调用方按任务提供）。 */
export function agentToolToInternalExecutor(
  tool: string,
  ctxProvider: () => AgentToolCtx,
): (capability: string, args: Record<string, unknown>) => Promise<ExecutionResult> {
  const impl = AGENT_TOOLS[tool as keyof typeof AGENT_TOOLS];
  if (!impl) throw new Error(`internal executor adapter: AGENT_TOOLS 无 ${tool}`);
  return async (_capability, args) => {
    const r = await impl(ctxProvider(), args);
    return agentToolResultToExecutionResult(r);
  };
}

/** 把 dev/write/debug 族批量注册进 internalExecutor 注册表。 */
export function registerDevWriteDebugExecutors(
  registry: InternalExecutorRegistry,
  ctxProvider: () => AgentToolCtx,
): void {
  for (const tool of DEV_WRITE_DEBUG_TOOLS) {
    registry.register(tool, agentToolToInternalExecutor(tool, ctxProvider));
  }
}
