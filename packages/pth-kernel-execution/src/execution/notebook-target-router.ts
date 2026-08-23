/**
 * notebook-target-router.ts —— NotebookTargetRouter（Execution Target Matrix）。
 *
 * 只依赖 `ExecutionTargetRegistry` 只读接口（contracts），不 import `src/pth/**`。
 * 职责：按 cell 的 `(language, target?)` 解析目标；执行语义由调用方（KernelExecChannel）
 * 按 `target.binding` 分发。
 */

import type {
  ExecutionTargetDefinition,
  ExecutionTargetRegistry,
  NotebookLanguage,
} from "@away_from/pth-contracts";

export interface NotebookTargetResolution {
  target: ExecutionTargetDefinition;
}

export function resolveNotebookTarget(
  registry: ExecutionTargetRegistry,
  language: NotebookLanguage,
  target?: string | null,
): NotebookTargetResolution {
  const resolved = registry.resolve(language, target ?? null);
  return { target: resolved };
}

/** 便捷：是否走 engine 内部解释器（engine-ts）。 */
export function isEngineInternalTarget(target: ExecutionTargetDefinition): boolean {
  return target.binding.type === "engine-internal";
}

/** 便捷：是否走 persistent execution-session（sandbox 等）。 */
export function isExecutionSessionTarget(target: ExecutionTargetDefinition): boolean {
  return target.binding.type === "execution-session";
}

/** 便捷：是否走一次性 execution-backend（local/tool/jupyter）。 */
export function isExecutionBackendTarget(target: ExecutionTargetDefinition): boolean {
  return target.binding.type === "execution-backend";
}
