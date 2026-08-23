/**
 * exec-tool-cap.ts —— 执行面角色授权（EXEC_TOOL_CAP）的 Command 层共用纯函数。
 *
 * 单一事实源：语言/生产工具需要哪些 capability，由本表推导；
 * 判定统一以角色 `capabilities` 数组为准（未声明 = 全量兼容；ts 族为基础执行面不校验）。
 */
export const EXEC_TOOL_CAP: Readonly<Record<string, readonly string[]>> = {
  python: ["python"],
  bash: ["bash"],
  dev: ["c", "dev", "python", "bash"],   // dev.run/list 只读——验收角色（python/bash）可用
  write: ["fs", "write"],
};

/** 取执行族所需 capabilities（未登记 = undefined = 不校验）。 */
export function execToolCapFor(execFam: string): readonly string[] | undefined {
  return EXEC_TOOL_CAP[execFam];
}

/**
 * 判断角色 capabilities 是否满足某执行族门控。
 * 与既有语义一致：未登记执行族或未声明 capabilities 均放行（向后兼容）。
 */
export function hasExecToolCapability(
  execFam: string,
  capabilities: readonly string[] | undefined,
): boolean {
  const need = EXEC_TOOL_CAP[execFam];
  if (!need) return true;
  if (!capabilities) return true;
  return need.some((c) => capabilities.includes(c));
}
