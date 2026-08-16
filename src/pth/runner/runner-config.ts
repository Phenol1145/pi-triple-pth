/**
 * runner/runner-config.ts — runner 运行配置（模块化 v2 P1-4）。
 *
 * 环境默认在 runner 内解析；测试/调度器可显式注入。
 */

export interface RunnerConfig {
  /** agent 循环开关（false → NL 一次转译 + PTC 程序执行） */
  agentMode: boolean;
  /** ASP 动作空间协议开关 */
  aspMode: boolean;
}

export function defaultRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  return {
    agentMode: env.PTH_AGENT_MODE !== "off",
    aspMode: env.PTH_ASP_MODE === "on",
  };
}
