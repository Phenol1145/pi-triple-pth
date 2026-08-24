/**
 * runtime/targets/local-container.ts —— 默认 deploy target：本机 docker compose。
 *
 * 逻辑自 runtime-orchestrator 原样搬入（compose argv 构造、waitHealthy、
 * runPthUp/runPthDown 委托），默认路径行为零变化。
 */
import { join } from "node:path";
import type { CommandRunner, DeployTarget, TargetContext } from "./types.js";

export interface ComposeServiceState {
  service: string;
  state: string;
  health?: string;
}

export function parseComposePsJson(stdout: string): ComposeServiceState[] {
  const out: ComposeServiceState[] = [];
  for (const line of stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    try {
      const entry = JSON.parse(line) as { Service?: string; Name?: string; State?: string; Health?: string };
      const service = entry.Service ?? entry.Name ?? "";
      if (!service) continue;
      out.push({ service, state: entry.State ?? "unknown", ...(entry.Health ? { health: entry.Health } : {}) });
    } catch {
      // 忽略非 JSON 行
    }
  }
  return out;
}

export function coreComposeArgs(repoRoot: string, envFile: string): string[] {
  return ["compose", "--env-file", envFile, "-f", join(repoRoot, "deploy", "docker-compose.yaml")];
}

export function jupyterComposeArgs(repoRoot: string): string[] {
  return ["compose", "-p", "pi-triple-jupyter", "-f", join(repoRoot, "deploy", "services", "jupyter", "docker-compose.yaml")];
}

export async function waitHealthy(
  runner: CommandRunner,
  composeArgs: string[],
  serviceIds: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await runner("docker", [...composeArgs, "ps", "--format", "json"], { env });
    const states = parseComposePsJson(result.stdout);
    const healthy = new Set(states.filter((s) => s.state === "running" && s.health === "healthy").map((s) => s.service));
    const missing = serviceIds.filter((id) => !healthy.has(id));
    if (missing.length === 0) return;
    if (Date.now() > deadline) throw new Error(`等待 healthy 超时: ${missing.join(", ")}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function defaultPthUp(): Promise<(args: string[], opts: { repoRoot: string }) => Promise<void>> {
  const mod = await import("@away_from/pth-console");
  return mod.runPthUp;
}

async function defaultPthDown(): Promise<(args: string[], opts: { repoRoot: string }) => Promise<void>> {
  const mod = await import("@away_from/pth-console");
  return mod.runPthDown;
}

export const localContainerTarget: DeployTarget = {
  id: "local-container",
  envPresets() {
    // W1 不接线 preset 注入；静态值仅供 status/config 展示（container compose 已硬编码同值）。
    return {
      PTH_PYTHON_MODE: "sandbox-kernel",
      PTH_BASH_MODE: "sandbox-kernel",
      PTH_EXEC_SANDBOX_ALIAS: "on",
      PTH_CONFIG_STRICT: "1",
    };
  },
  async upData(ctx: TargetContext, services: readonly string[]): Promise<void> {
    const args = coreComposeArgs(ctx.repoRoot, ctx.envFile);
    const result = await ctx.runner("docker", [...args, "up", "-d", ...services], { env: ctx.env });
    if (result.code !== 0) throw new Error(`数据层 ${services.join(",")} 启动失败: ${result.stderr || result.stdout}`);
    await waitHealthy(ctx.runner, args, [...services], ctx.timeoutMs, ctx.env);
  },
  async down(ctx: TargetContext, forward: string[]): Promise<void> {
    const pthDown = ctx.pthDown ?? await defaultPthDown();
    await pthDown(forward, { repoRoot: ctx.repoRoot });
  },
  async engineUp(ctx: TargetContext, forward: string[]): Promise<void> {
    const pthUp = ctx.pthUp ?? await defaultPthUp();
    await pthUp(forward, { repoRoot: ctx.repoRoot });
  },
};
