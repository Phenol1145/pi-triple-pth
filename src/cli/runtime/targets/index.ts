/**
 * runtime/targets/index.ts —— Deploy Target 注册表。
 */
import { localContainerTarget } from "./local-container.js";
import { localProcessTarget } from "./local-process.js";
import type { DeployTarget, DeployTargetId } from "./types.js";

export const DEPLOY_TARGETS: readonly DeployTarget[] = [localContainerTarget, localProcessTarget];

export function resolveTarget(id: string): DeployTarget {
  const target = DEPLOY_TARGETS.find((t) => t.id === id);
  if (!target) {
    throw new Error(`unknown target: ${id}（可选 ${DEPLOY_TARGETS.map((t) => t.id).join("|")}）`);
  }
  return target;
}

export const DEPLOY_TARGET_IDS = DEPLOY_TARGETS.map((t) => t.id) as readonly DeployTargetId[];

export type { DeployTarget, DeployTargetId, TargetContext, CommandRunner, CommandRunResult, EnvPresetOptions } from "./types.js";
export {
  coreComposeArgs,
  jupyterComposeArgs,
  localContainerTarget,
  parseComposePsJson,
  waitHealthy,
  type ComposeServiceState,
} from "./local-container.js";
export {
  buildExecBackends,
  confirmLocalProcessTrust,
  createLocalProcessTarget,
  localProcessTarget,
  parseUrlHostPort,
  type LocalProcessDeps,
} from "./local-process.js";
export { classifyContainerRuntime, detectContainerRuntime, runtimeCapabilities, type ContainerRuntime } from "./detect.js";
