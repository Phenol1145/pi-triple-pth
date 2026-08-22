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
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
}

const VALUE_FLAGS = new Set(["--profile", "--with", "--without", "--env-file", "--timeout", "--port", "--tenant", "--token"]);

export function hasOrchestrationFlags(args: string[]): boolean {
  return args.includes("--all") || args.includes("--profile") || args.includes("--with") || args.includes("--without");
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export function parseOrchestratedArgs(args: string[], cmd: "up" | "down" | "status"): OrchestratedArgs {
  if (args.includes("--profile") && flagValue(args, "--profile") === undefined) {
    throw new Error("--profile 需要取值: core|tools|lean4|u8|jupyter|full");
  }
  const profile = args.includes("--all") ? "full" : (flagValue(args, "--profile") ?? "core");
  const withIds = (flagValue(args, "--with") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const withoutIds = (flagValue(args, "--without") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const forward: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--all" || a === "--profile" || a === "--with" || a === "--without") {
      if (VALUE_FLAGS.has(a)) i += 1; // 跳过值（--all 无值，多跳无害：下一轮 i++ 覆盖）
      continue;
    }
    forward.push(a);
  }
  void cmd;
  return { profile, withIds, withoutIds, forward };
}

function defaultRunner(): CommandRunner {
  return (cmd, argv, opts) =>
    new Promise<CommandRunResult>((resolvePromise) => {
      const child = spawn(cmd, argv, { stdio: ["pipe", "pipe", "pipe"], ...(opts?.env ? { env: opts.env } : {}) });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", (e) => resolvePromise({ code: -1, stdout, stderr: String(e.message ?? e) }));
      child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
      if (opts?.input !== undefined) child.stdin?.end(opts.input);
      else child.stdin?.end();
    });
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

function coreComposeArgs(repoRoot: string, envFile: string): string[] {
  return ["compose", "--env-file", envFile, "-f", join(repoRoot, "deploy", "docker-compose.yaml")];
}

function jupyterComposeArgs(repoRoot: string): string[] {
  return ["compose", "-p", "pi-triple-jupyter", "-f", join(repoRoot, "deploy", "services", "jupyter", "docker-compose.yaml")];
}

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

async function waitHealthy(
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
  const doctorReport = await doctorFn(["--profile", resolvedProfile.name], { repoRoot, env: baseEnv });
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

  // 2) 数据层（分服务 up + health wait；不先起 engine）
  let step = 1;
  const totalSteps = dataComponents.length + optionalComponents.length + 1;
  const coreArgs = coreComposeArgs(repoRoot, envFile);
  for (const component of dataComponents) {
    log(`▶ ${step++}/${totalSteps} 数据层 ${component.id}（${component.services?.join(",") ?? ""}）…`);
    const result = await runner("docker", [...coreArgs, "up", "-d", ...(component.services ?? [])], { env });
    if (result.code !== 0) throw new Error(`数据层 ${component.id} 启动失败: ${result.stderr || result.stdout}`);
    await waitHealthy(runner, coreArgs, component.services ?? [], timeoutMs, env);
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
  const pthUp = deps.pthUp ?? await defaultPthLauncher("up");
  await pthUp(upArgs, { repoRoot });
  log("✔ engine 已启动并验证");
  if (token) log(`operator token（同源 JUPYTER_ENGINE_TOKEN）：${seed && explicitToken === undefined ? "已生成并种入 Redis" : "使用 --token 指定值"}`);
}

export async function orchestrateDown(args: string[], deps: OrchestratorDeps): Promise<void> {
  const parsed = parseOrchestratedArgs(args, "down");
  const log = deps.log ?? ((line: string) => console.log(line));
  const repoRoot = resolve(deps.repoRoot);
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
  const pthDown = deps.pthDown ?? await defaultPthLauncher("down");
  await pthDown(parsed.forward, { repoRoot });
  log("✔ pth down 完成");
}

export async function orchestrateStatusAll(args: string[], deps: OrchestratorDeps): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const repoRoot = resolve(deps.repoRoot);
  const runner = deps.runner ?? defaultRunner();
  const envFile = flagValue(args, "--env-file") ?? join(repoRoot, "deploy", ".env.pth.secrets");
  const env = deps.env ?? process.env;
  const forward = args.filter((a) => a !== "--all");

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
