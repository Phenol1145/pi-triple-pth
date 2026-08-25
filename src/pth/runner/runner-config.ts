/**
 * runner/runner-config.ts — runner 运行配置（模块化 v2 P1-4）。
 *
 * 执行模式入口统一为 `PTH_EXEC_MODE`：
 *   - 只读原始 env / 显式注入值，不读取 config schema 回填默认值；
 *   - 显式非法值 fail-fast；
 *   - 兼容别名：`PTH_ASP_MODE=on` → asp；`PTH_AGENT_MODE=off` → pulse；
 *     缺省 → tool-call。
 */

import type { ExecMode } from "@away_from/pth-kernel-execution";

export type { ExecMode };

export const EXEC_MODES: readonly ExecMode[] = ["tool-call", "asp", "ptc", "pulse"];

export function isExecMode(v: unknown): v is ExecMode {
  return typeof v === "string" && (EXEC_MODES as readonly string[]).includes(v);
}

/** 只从原始 env/显式值解析；不允许 config-schema 默认值混入。 */
export function resolveExecMode(env: NodeJS.ProcessEnv = process.env): ExecMode {
  const explicit = env.PTH_EXEC_MODE;
  if (explicit !== undefined && explicit !== null && explicit.trim() !== "") {
    if (!isExecMode(explicit)) {
      throw new Error(`PTH_EXEC_MODE 非法值 "${explicit}"（允许：${EXEC_MODES.join(" / ")}）`);
    }
    return explicit;
  }
  if (env.PTH_ASP_MODE === "on") return "asp";
  if (env.PTH_AGENT_MODE === "off") return "pulse";
  return "tool-call";
}

export interface RunnerConfig {
  /** 统一执行模式 */
  execMode: ExecMode;
  /** 是否显式设置 PTH_EXEC_MODE（缺省/别名兼容时 false——允许 legacy pulse fallback） */
  execModeExplicit: boolean;
  /** agent 循环开关（tool-call/asp 为 agent 循环；pulse/ptc 非 agent loop） */
  agentMode: boolean;
  /** ASP 动作空间协议开关 */
  aspMode: boolean;
  /** pulse 快路径开关（PTH_EXEC_MODE=pulse 或兼容别名） */
  pulseMode: boolean;
}

export function defaultRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const execMode = resolveExecMode(env);
  const explicit = env.PTH_EXEC_MODE !== undefined && env.PTH_EXEC_MODE !== null && env.PTH_EXEC_MODE.trim() !== "";
  return {
    execMode,
    execModeExplicit: explicit,
    agentMode: execMode === "tool-call" || execMode === "asp",
    aspMode: execMode === "asp",
    pulseMode: execMode === "pulse",
  };
}
