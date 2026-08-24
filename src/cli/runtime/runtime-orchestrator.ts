/**
 * runtime/runtime-orchestrator.ts —— P6-3/4/5/6 `pth up/down/status` 运行时剖面编排。
 *
 * 顺序（P6 设计 §4 修正版）：
 *   doctor → secrets env 注入 → 数据层（postgres/redis/sandbox 分服务 up + health wait）
 *   → 生成 operator token（同源）→ 宿主服务 → tools → jupyter（south /health + 北 8888）
 *   → 最后 engine（pth up --token）→ verify。
 *
 * down 反向：外围（jupyter → u8 → lean → tools）→ core 原子组（pth down）。
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSpawnRunner } from "./spawn-runner.js";
import type { DoctorReport } from "./runtime-doctor.js";
import {
  resolveProfile,
  validateRuntimeProfiles,
  type RuntimeComponent,
  type RuntimeProfilesFile,
} from "./runtime-profiles.js";
import {
  applySecretsToProcessEnv,
  injectSecrets,
  loadSecretsFile,
  missingSecretKeys,
} from "./runtime-secrets.js";
import {
  DEPLOY_TARGET_IDS,
  coreComposeArgs,
  jupyterComposeArgs,
  resolveTarget,
  waitHealthy,
  type CommandRunner,
  type TargetContext,
} from "./targets/index.js";

export type { CommandRunner, CommandRunResult } from "./targets/index.js";

export interface OrchestratorDeps {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  profiles?: RuntimeProfilesFile;
  servicesCommand?: (args: string[]) => Promise<void>;
  toolsCommand?: (args: string[]) => Promise<void>;
  pthUp?: (args: string[], opts: { repoRoot: string }) => Promise<void>;
  pthDown?: (args: string[], opts: { repoRoot: string }) => Promise<void>;
  pthStatus?: (args: string[], opts: { repoRoot: string }) => Promise<void>;
  doctor?: (args: string[], opts: { repoRoot: string; env?: NodeJS.ProcessEnv }) => Promise<DoctorReport>;
  fetchLike?: typeof fetch;
  log?: (line: string) => void;
}

export interface OrchestratedArgs {
  profile: string;
  withIds: string[];
  withoutIds: string[];
  forward: string[];
  target: string;
  runtimeOverride?: string;
  sandbox: "process" | "none";
}

const VALUE_FLAGS = new Set([
  "--profile", "--with", "--without", "--env-file", "--timeout", "--port", "--tenant", "--token",
  "--target", "--runtime", "--sandbox",
]);

export function hasOrchestrationFlags(args: string[]): boolean {
  return args.includes("--all") || args.includes("--profile") || args.includes("--with") || args.includes("--without")
    || args.includes("--target") || args.includes("--runtime") || args.includes("--sandbox");
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export function parseOrchestratedArgs(args: string[], cmd: "up" | "down" | "status"): OrchestratedArgs {
  if (args.includes("--profile") && flagValue(args, "--profile") === undefined) {
    throw new Error("--profile 需要取值: core|tools|lean4|u8|jupyter|full");
  }
  if (args.includes("--target") && flagValue(args, "--target") === undefined) {
    throw new Error("--target 需要取值");
  }
  if (args.includes("--runtime") && flagValue(args, "--runtime") === undefined) {
    throw new Error("--runtime 需要取值");
  }
  if (args.includes("--sandbox") && flagValue(args, "--sandbox") === undefined) {
    throw new Error("--sandbox 需要取值 process|none");
  }
  const profile = args.includes("--all") ? "full" : (flagValue(args, "--profile") ?? "core");
  const withIds = (flagValue(args, "--with") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const withoutIds = (flagValue(args, "--without") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const target = flagValue(args, "--target") ?? "local-container";
  if (!DEPLOY_TARGET_IDS.includes(target as (typeof DEPLOY_TARGET_IDS)[number])) {
    throw new Error(`unknown target: ${target}（可选 ${DEPLOY_TARGET_IDS.join("|")}）`);
  }
  const runtimeOverride = flagValue(args, "--runtime");
  const sandboxRaw = flagValue(args, "--sandbox") ?? "process";
  if (sandboxRaw !== "process" && sandboxRaw !== "none") {
    throw new Error("--sandbox 需要取值 process|none");
  }
  const forward: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--all" || a === "--profile" || a === "--with" || a === "--without"
      || a === "--target" || a === "--runtime" || a === "--sandbox") {
      if (VALUE_FLAGS.has(a)) i += 1; // 跳过值（--all 无值，多跳无害：下一轮 i++ 覆盖）
      continue;
    }
    forward.push(a);
  }
  void cmd;
  return { profile, withIds, withoutIds, forward, target, ...(runtimeOverride ? { runtimeOverride } : {}), sandbox: sandboxRaw as "process" | "none" };
}

function defaultRunner(): CommandRunner {
  return createSpawnRunner();
}

async function defaultServicesCommand(): Promise<(args: string[]) => Promise<void>> {
  const { servicesCommand } = await import("../../pth/services/cli.js");
  return servicesCommand;
}

async function defaultToolsCommand(): Promise<(args: string[]) => Promise<void>> {
  const { toolsCommand } = await import("../../pth/tools/cli.js");
  return toolsCommand;
}

async function defaultPthLauncher(cmd: "up" | "down" | "status"): Promise<(args: string[], opts: { repoRoot: string }) => Promise<void>> {
  const mod = await import("@away_from/pth-console");
  if (cmd === "up") return mod.runPthUp;
  if (cmd === "down") return mod.runPthDown;
  return mod.runPthStatus;
}

async function loadProfilesFile(repoRoot: string): Promise<RuntimeProfilesFile> {
  const text = await readFile(join(repoRoot, "deploy", "runtime-profiles.json"), "utf8");
  return validateRuntimeProfiles(JSON.parse(text) as unknown);
}

export type { ComposeServiceState } from "./targets/local-container.js";
export { coreComposeArgs, jupyterComposeArgs, parseComposePsJson, waitHealthy } from "./targets/local-container.js";

function generatedToken(): string {
  return randomBytes(32).toString("hex");
}

export async function orchestrateUp(args: string[], deps: OrchestratorDeps): Promise<void> {
  const parsed = parseOrchestratedArgs(args, "up");
  const runner = deps.runner ?? defaultRunner();
  const log = deps.log ?? ((line: string) => console.log(line));
  const repoRoot = resolve(deps.repoRoot);
  const envFile = flagValue(args, "--env-file") ?? join(repoRoot, "deploy", ".env.pth.secrets");
  const timeoutMs = Number(flagValue(args, "--timeout") ?? "300") * 1000;
  const secrets = await loadSecretsFile(repoRoot, flagValue(args, "--env-file"));

  const profiles = deps.profiles ?? await loadProfilesFile(repoRoot);
  const resolvedProfile = resolveProfile(profiles, parsed.profile, {
    withIds: parsed.withIds,
    withoutIds: parsed.withoutIds,
  });
  const baseEnv = injectSecrets(deps.env ?? process.env, secrets);
  if (deps.env === undefined) applySecretsToProcessEnv(secrets);

  // 1) doctor（失败即停）
  const doctorFn = deps.doctor ?? (async (doctorArgs, opts) => {
    const { runDoctor } = await import("./runtime-doctor.js");
    return runDoctor(doctorArgs, { repoRoot: opts.repoRoot, env: opts.env });
  });
  const doctorArgs = ["--profile", resolvedProfile.name];
  if (parsed.runtimeOverride) doctorArgs.push("--runtime", parsed.runtimeOverride);
  const doctorReport = await doctorFn(doctorArgs, { repoRoot, env: baseEnv });
  if (!doctorReport.ok) {
    throw new Error("doctor 有阻断项：修复后重试（pth doctor --profile " + resolvedProfile.name + "）");
  }

  const dataComponents = resolvedProfile.components.filter((c) => c.phase === "data" && c.kind === "compose");
  const optionalComponents = resolvedProfile.components.filter((c) => c.phase === "optional");
  const jupyter = optionalComponents.find((c) => c.id === "jupyter");
  const seed = !parsed.forward.includes("--no-seed-token");
  const explicitToken = flagValue(parsed.forward, "--token");
  const token = seed ? (explicitToken ?? generatedToken()) : undefined;
  if (!seed && jupyter) throw new Error("--no-seed-token 与 jupyter 组件冲突：pi-kernel 需要 engine token，去掉 --no-seed-token 或 --without jupyter");

  const env = { ...baseEnv };
  if (token) env.JUPYTER_ENGINE_TOKEN = token;

  const target = resolveTarget(parsed.target);
  const ctx: TargetContext = {
    repoRoot,
    env,
    envFile,
    runner,
    timeoutMs,
    log,
    pthUp: deps.pthUp ?? await defaultPthLauncher("up"),
    pthDown: deps.pthDown ?? await defaultPthLauncher("down"),
    pthStatus: deps.pthStatus ?? await defaultPthLauncher("status"),
  };

  // 2) 数据层（分服务 up + health wait；不先起 engine）
  let step = 1;
  const totalSteps = dataComponents.length + optionalComponents.length + 1;
  for (const component of dataComponents) {
    log(`▶ ${step++}/${totalSteps} 数据层 ${component.id}（${component.services?.join(",") ?? ""}）…`);
    await target.upData(ctx, component.services ?? []);
    log(`✔ ${component.id} healthy`);
  }

  // 3) 可选组件（tools → local-lean → local-u8 → jupyter）
  const services = deps.servicesCommand ?? await defaultServicesCommand();
  const tools = deps.toolsCommand ?? await defaultToolsCommand();
  for (const component of optionalComponents) {
    log(`▶ ${step++}/${totalSteps} 可选组件 ${component.id} …`);
    if (component.kind === "tools") {
      await tools(["up"]);
    } else if (component.kind === "service") {
      const effectiveSecrets = { ...secrets, ...(token ? { JUPYTER_ENGINE_TOKEN: token } : {}) };
      const missing = missingSecretKeys(effectiveSecrets, component.secretKeys ?? []);
      if (missing.length > 0) throw new Error(`${component.id} 需要 secrets: ${missing.join(", ")}（编辑 deploy/.env.pth.secrets 后重试）`);
      await services(["up", component.serviceId ?? component.id]);
      if (component.id === "jupyter") {
        await waitHealthy(runner, jupyterComposeArgs(repoRoot), ["jupyter"], timeoutMs, env);
      }
    }
    log(`✔ ${component.id} 已启动`);
  }

  // 4) engine 最后（复用 runPthUp；幂等 re-up 数据层）
  log(`▶ ${step}/${totalSteps} engine 最后启动（probe 全部 backend）…`);
  const upArgs = [...parsed.forward];
  if (seed && explicitToken === undefined) upArgs.push("--token", token!);
  await target.engineUp(ctx, upArgs);
  log("✔ engine 已启动并验证");
  if (token) log(`operator token（同源 JUPYTER_ENGINE_TOKEN）：${seed && explicitToken === undefined ? "已生成并种入 Redis" : "使用 --token 指定值"}`);
}

export async function orchestrateDown(args: string[], deps: OrchestratorDeps): Promise<void> {
  const parsed = parseOrchestratedArgs(args, "down");
  const log = deps.log ?? ((line: string) => console.log(line));
  const repoRoot = resolve(deps.repoRoot);
  const runner = deps.runner ?? defaultRunner();
  const profiles = deps.profiles ?? await loadProfilesFile(repoRoot);
  const resolvedProfile = resolveProfile(profiles, parsed.profile, {
    withIds: parsed.withIds,
    withoutIds: parsed.withoutIds,
  });

  // P6 live 验证修复（2026-08-22）：down 与 up 同源注入 secrets——
  // jupyter compose 的 JUPYTER_SERVICE_TOKEN/PTH_WORKSPACES_HOST 为 :? 必填，
  // 缺 env 时 docker compose down 会插值失败（services CLI 不传 --env-file）。
  const secrets = await loadSecretsFile(repoRoot, flagValue(args, "--env-file"));
  if (deps.env === undefined) applySecretsToProcessEnv(secrets);

  const optional = resolvedProfile.components.filter((c) => c.phase === "optional").reverse();
  const services = deps.servicesCommand ?? await defaultServicesCommand();
  const tools = deps.toolsCommand ?? await defaultToolsCommand();
  for (const component of optional) {
    log(`▼ 停止外围 ${component.id} …`);
    if (component.kind === "tools") await tools(["down"]);
    else if (component.kind === "service") await services(["down", component.serviceId ?? component.id]);
  }
  log("▼ 停止 core 栈（engine + sandbox + postgres + redis 原子组）…");
  const target = resolveTarget(parsed.target);
  const ctx: TargetContext = {
    repoRoot,
    env: deps.env ?? process.env,
    envFile: flagValue(args, "--env-file") ?? join(repoRoot, "deploy", ".env.pth.secrets"),
    runner,
    timeoutMs: 300_000,
    log,
    pthUp: deps.pthUp ?? await defaultPthLauncher("up"),
    pthDown: deps.pthDown ?? await defaultPthLauncher("down"),
    pthStatus: deps.pthStatus ?? await defaultPthLauncher("status"),
  };
  await target.down(ctx, parsed.forward);
  log("✔ pth down 完成");
}

export async function orchestrateStatusAll(args: string[], deps: OrchestratorDeps): Promise<void> {
  const parsed = parseOrchestratedArgs(args, "status");
  const log = deps.log ?? ((line: string) => console.log(line));
  const repoRoot = resolve(deps.repoRoot);
  const runner = deps.runner ?? defaultRunner();
  const envFile = flagValue(args, "--env-file") ?? join(repoRoot, "deploy", ".env.pth.secrets");
  const env = deps.env ?? process.env;
  const forward = parsed.forward;
  const target = resolveTarget(parsed.target);

  log("── core 栈 ──");
  const pthStatus = deps.pthStatus ?? await defaultPthLauncher("status");
  await pthStatus(forward, { repoRoot });

  log("");
  log("── 宿主服务与 jupyter（pth services）──");
  const services = deps.servicesCommand ?? await defaultServicesCommand();
  await services(["status"]);

  log("");
  log("── 工具容器（pth tools）──");
  const tools = deps.toolsCommand ?? await defaultToolsCommand();
  await tools(["status"]);

  if (target.statusData) {
    const extra = await target.statusData({
      repoRoot,
      env,
      envFile,
      runner,
      timeoutMs: 300_000,
      log,
      pthUp: deps.pthUp ?? await defaultPthLauncher("up"),
      pthDown: deps.pthDown ?? await defaultPthLauncher("down"),
      pthStatus,
    });
    if (extra.length > 0) {
      log("");
      log("── engine 专业 runtime 注册态 ──");
      for (const line of extra) log(line);
    }
    return;
  }

  log("");
  log("── engine 专业 runtime 注册态 ──");
  const logs = await runner("docker", [...coreComposeArgs(repoRoot, envFile), "logs", "--tail", "500", "pi-platform"], { env });
  const logText = `${logs.stdout}\n${logs.stderr}`;
  // 取最后一条注册日志：engine 重启会追加新行，首条可能是旧的注册快照
  const matches = [...logText.matchAll(/professional runtimes registered[^"\n]*/gi)];
  const marker = matches.length > 0 ? matches[matches.length - 1] : undefined;
  log(marker ? `  ${marker[0].trim()}` : "  未观察到注册日志（engine 未启动或日志被轮转；docker compose logs pi-platform 查看）");

  const token = env.PTH_TOKEN;
  if (token) {
    const port = Number(flagValue(forward, "--port") ?? "3000");
    const fetchLike = deps.fetchLike ?? fetch;
    try {
      const res = await fetchLike(`http://127.0.0.1:${port}/api/v1/kernel/status`, { headers: { authorization: `Bearer ${token}` } });
      const body = await res.text();
      log("");
      log(`── engine /api/v1/kernel/status（${res.status}）──`);
      log(body.slice(0, 2000));
    } catch (e) {
      log("");
      log(`engine kernel status 不可达: ${String(e instanceof Error ? e.message : e)}`);
    }
  }
}

export function componentIdsOf(components: RuntimeComponent[]): string[] {
  return components.map((c) => c.id);
}
