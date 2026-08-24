/**
 * runtime/targets/types.ts —— Deploy Target 公共类型。
 *
 * target 表示“在哪/怎么跑”（local-container / local-process），与 profile
 * （起哪些组件）正交。orchestrator 持有组件序，target 提供数据层/engine/down
 * 的执行原语与 env preset。
 */
import type { RuntimeComponent } from "../runtime-profiles.js";

export type DeployTargetId = "local-container" | "local-process";

export interface CommandRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  cmd: string,
  argv: string[],
  opts?: { readonly env?: NodeJS.ProcessEnv; readonly input?: string },
) => Promise<CommandRunResult>;

export interface TargetContext {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  envFile: string;
  runner: CommandRunner;
  timeoutMs: number;
  log: (line: string) => void;
  /** engine/down 委托（测试注入 seam；缺省回落 pth-console）。 */
  pthUp?: (args: string[], opts: { repoRoot: string }) => Promise<void>;
  pthDown?: (args: string[], opts: { repoRoot: string }) => Promise<void>;
  pthStatus?: (args: string[], opts: { repoRoot: string }) => Promise<void>;
}

export interface DeployTarget {
  readonly id: DeployTargetId;
  envPresets(opts: { sandbox: "process" | "none" }): Record<string, string>;
  upData(ctx: TargetContext, services: readonly string[]): Promise<void>;
  down(ctx: TargetContext, forward: string[]): Promise<void>;
  engineUp(ctx: TargetContext, forward: string[]): Promise<void>;
  statusData?(ctx: TargetContext): Promise<string[]>;
}

export type { RuntimeComponent };
