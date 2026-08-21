/**
 * pth-console/src/launcher.ts —— PTH compose 启动器（pth init/up/down/status/logs）。
 *
 * 产品形态：local-only。启动器只在本机编排 docker compose，不承担服务端权限模型；
 * 所有容器凭据仍来自 deploy/.env.pth.secrets（不落盘、不打印）。
 *
 * 命令语义：
 *   pth init                    初始化 deploy/.env.pth.secrets（复制 example + chmod 600）
 *   pth up                      依赖顺序拉起 + 等待 healthy + 种 operator token + 验证
 *   pth down [--volumes]        停栈（可选清卷）
 *   pth status [--port n]       栈健康 + API 状态（无 taskId；有 taskId 仍走任务查询）
 *   pth logs [service] [--tail n] [--follow]
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ComposeRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ComposeRunner = (
  args: string[],
  opts?: { readonly input?: string },
) => Promise<ComposeRunResult>;

export interface LauncherFetchResult {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type LauncherFetch = (
  url: string,
  init?: { readonly headers?: Record<string, string> },
) => Promise<LauncherFetchResult>;

export interface PthLauncherOptions {
  readonly repoRoot: string;
  readonly runner?: ComposeRunner;
  readonly fetch?: LauncherFetch;
  readonly randomToken?: () => string;
}

export class PthLauncherError extends Error {
  readonly code:
    | "SECRETS_MISSING"
    | "SECRETS_INCOMPLETE"
    | "COMPOSE_FAILED"
    | "HEALTHY_TIMEOUT"
    | "ARG_INVALID"
    | "TOKEN_INVALID"
    | "TENANT_INVALID"
    | "TOKEN_SEED_FAILED"
    | "VERIFY_FAILED"
    | "INIT_FAILED";
  readonly detail?: string;
  constructor(code: PthLauncherError["code"], message: string, detail?: string) {
    super(message);
    this.name = "PthLauncherError";
    this.code = code;
    this.detail = detail;
  }
}

const COMPOSE_FILE = "deploy/docker-compose.yaml";
const SECRETS_FILE = "deploy/.env.pth.secrets";
const SECRETS_EXAMPLE = "deploy/.env.pth.secrets.example";
export const REQUIRED_SECRET_KEYS = [
  "SANDBOX_SHARED_SECRET",
  "PTH_EXECUTION_GRANT_SECRET",
  "PTH_MEMORY_BRIDGE_TOKEN",
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
] as const;

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/;
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface ComposeServiceState {
  readonly service: string;
  readonly state: string;
  readonly health?: string;
  readonly status?: string;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    const value = withoutExport.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export function parseComposePs(stdout: string): ComposeServiceState[] {
  const out: ComposeServiceState[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, string>;
      const service = entry.Service ?? entry.Name ?? "";
      if (!service) continue;
      out.push({
        service,
        state: entry.State ?? "unknown",
        ...(entry.Health ? { health: entry.Health } : {}),
        ...(entry.Status ? { status: entry.Status } : {}),
      });
    } catch {
      // compose ps 非 JSON 行（warning）忽略
    }
  }
  return out;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function defaultRunner(): ComposeRunner {
  return (args, opts) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
      child.stdin.end(opts?.input ?? "");
    });
}

async function defaultFetch(url: string, init?: { headers?: Record<string, string> }): Promise<LauncherFetchResult> {
  if (typeof globalThis.fetch !== "function") {
    throw new PthLauncherError("VERIFY_FAILED", "runtime has no global fetch (need Node >= 18)");
  }
  const response = await globalThis.fetch(url, {
    method: "GET",
    headers: init?.headers,
  });
  return {
    ok: response.ok,
    status: response.status,
    text: async () => await response.text(),
  };
}

function defaultRandomToken(): string {
  return randomBytes(32).toString("hex");
}

function flagInt(args: string[], name: string, fallback: number, min: number, max: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new PthLauncherError("ARG_INVALID", `${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

/** 取第一个位置参数（跳过 flag 及其值）。 */
function positional(args: string[], valuedFlags: string[]): string | undefined {
  const values = new Set(valuedFlags);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i]!.startsWith("-")) {
      if (values.has(args[i]!)) i += 1;
      continue;
    }
    return args[i];
  }
  return undefined;
}

export function createPthLauncher(options: PthLauncherOptions) {
  const repoRoot = options.repoRoot;
  const runner = options.runner ?? defaultRunner();
  const fetchLike = options.fetch ?? defaultFetch;
  const randomToken = options.randomToken ?? defaultRandomToken;
  const composeFile = resolve(repoRoot, COMPOSE_FILE);
  const defaultSecrets = resolve(repoRoot, SECRETS_FILE);
  const exampleSecrets = resolve(repoRoot, SECRETS_EXAMPLE);

  function composeWith(envFile: string) {
    return (args: string[], opts?: { input?: string }): Promise<ComposeRunResult> =>
      runner(["compose", "--env-file", envFile, "-f", composeFile, ...args], opts);
  }

  async function requireSecrets(envFile: string): Promise<Record<string, string>> {
    let text: string;
    try {
      text = await readFile(envFile, "utf8");
    } catch {
      throw new PthLauncherError(
        "SECRETS_MISSING",
        `${envFile} not found. Run: npm run pth -- init`,
        `compose file: ${composeFile}`,
      );
    }
    const parsed = parseEnvFile(text);
    const missing = REQUIRED_SECRET_KEYS.filter((key) => (parsed[key] ?? "").length === 0);
    if (missing.length > 0) {
      throw new PthLauncherError(
        "SECRETS_INCOMPLETE",
        `${envFile} missing required values: ${missing.join(", ")}`,
      );
    }
    return parsed;
  }

  async function ensureCompose(args: string[], compose: (a: string[], o?: { input?: string }) => Promise<ComposeRunResult>, opts?: { input?: string }): Promise<ComposeRunResult> {
    const result = await compose(args, opts);
    if (result.code !== 0) {
      throw new PthLauncherError(
        "COMPOSE_FAILED",
        `docker compose ${args.join(" ")} failed (exit ${result.code})`,
        (result.stderr || result.stdout).slice(-2000),
      );
    }
    return result;
  }

  function serviceReady(service: ComposeServiceState): boolean {
    if (service.health !== undefined) return service.health === "healthy";
    return service.state === "running";
  }

  async function waitForHealthy(compose: ReturnType<typeof composeWith>, services: readonly string[], timeoutMs: number): Promise<ComposeServiceState[]> {
    const deadline = Date.now() + timeoutMs;
    let lastStates: ComposeServiceState[] = [];
    for (;;) {
      const result = await ensureCompose(["ps", "--format", "json"], compose);
      lastStates = parseComposePs(result.stdout).filter((entry) => services.includes(entry.service));
      const byService = new Map(lastStates.map((entry) => [entry.service, entry]));
      const notReady = services.filter((service) => !byService.has(service) || !serviceReady(byService.get(service)!));
      if (notReady.length === 0) return lastStates;
      if (Date.now() > deadline) {
        throw new PthLauncherError(
          "HEALTHY_TIMEOUT",
          `services not healthy after ${timeoutMs}ms: ${notReady.join(", ")}`,
          JSON.stringify(lastStates, null, 2),
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async function seedOperatorToken(
    compose: ReturnType<typeof composeWith>,
    token: string,
    tenant: string,
  ): Promise<void> {
    if (!TOKEN_RE.test(token)) {
      throw new PthLauncherError("TOKEN_INVALID", "--token must match [A-Za-z0-9][A-Za-z0-9._~-]{15,127}");
    }
    if (!TENANT_RE.test(tenant)) {
      throw new PthLauncherError("TENANT_INVALID", "--tenant must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}");
    }
    const payload = JSON.stringify({ tenantId: tenant, role: "platform-admin" });
    const script = `redis-cli -a "$REDIS_PASSWORD" -x SET auth:token:${token}`;
    const result = await compose(["exec", "-T", "redis", "sh", "-c", script], { input: payload });
    if (result.code !== 0) {
      throw new PthLauncherError("TOKEN_SEED_FAILED", "failed to write operator token to redis", (result.stderr || result.stdout).slice(-2000));
    }
  }

  async function httpText(url: string, headers?: Record<string, string>): Promise<string> {
    const response = await fetchLike(url, headers ? { headers } : undefined);
    return response.text();
  }

  async function verifyApi(port: number, token: string | undefined): Promise<void> {
    const base = `http://127.0.0.1:${port}`;
    const healthResponse = await fetchLike(`${base}/health`);
    if (!healthResponse.ok) {
      throw new PthLauncherError("VERIFY_FAILED", `/health returned ${healthResponse.status}: ${(await healthResponse.text()).slice(0, 200)}`);
    }
    if (token) {
      const versionResponse = await fetchLike(`${base}/api/v1/self/version`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!versionResponse.ok) {
        throw new PthLauncherError("VERIFY_FAILED", `/api/v1/self/version returned ${versionResponse.status}: ${(await versionResponse.text()).slice(0, 200)}`);
      }
    }
  }

  function helpUp(): void {
    console.log([
      "用法: npm run pth -- up [--env-file <path>] [--port <n>] [--tenant <id>] [--token <t>] [--timeout <s>] [--rebuild] [--no-seed-token] [--no-verify]",
      "  --env-file <path>    secrets 文件（默认 deploy/.env.pth.secrets）",
      "  --port <n>           本机验证端口（默认 3000）",
      "  --tenant <id>        operator token 的 tenantId（默认 ops）",
      "  --token <t>          指定 operator token；缺省自动生成 64 hex",
      "  --timeout <s>        等待 healthy 的秒数（默认 300）",
      "  --rebuild            启动前重编 pi-platform/sandbox 镜像",
      "  --no-seed-token      不写 operator token（只起栈）",
      "  --no-verify          跳过 HTTP health/version 验证",
    ].join("\n"));
  }

  async function up(args: string[]): Promise<void> {
    if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
      helpUp();
      return;
    }
    const envFile = resolve(flag(args, "--env-file") ?? defaultSecrets);
    const port = flagInt(args, "--port", 3000, 1, 65535);
    const timeoutSec = flagInt(args, "--timeout", 300, 1, 3600);
    const tenant = flag(args, "--tenant") ?? "ops";
    const token = hasFlag(args, "--no-seed-token") ? undefined : (flag(args, "--token") ?? randomToken());
    const rebuild = hasFlag(args, "--rebuild");
    const noVerify = hasFlag(args, "--no-verify");
    await requireSecrets(envFile);
    const compose = composeWith(envFile);
    const upArgs = rebuild ? ["up", "-d", "--build"] : ["up", "-d"];

    console.log("▶ 1/4 数据层（postgres + redis）…");
    await ensureCompose([...upArgs, "postgres", "redis"], compose);
    await waitForHealthy(compose, ["postgres", "redis"], timeoutSec * 1000);
    console.log("✔ postgres/redis healthy");

    console.log("▶ 2/4 应用层（pi-platform + sandbox）…");
    await ensureCompose([...upArgs, "pi-platform", "sandbox"], compose);
    await waitForHealthy(compose, ["pi-platform", "sandbox"], timeoutSec * 1000);
    console.log("✔ pi-platform/sandbox healthy");

    if (token) {
      console.log(`▶ 3/4 种入 operator token（tenant=${tenant} role=platform-admin）…`);
      await seedOperatorToken(compose, token, tenant);
      console.log("✔ operator token seeded");
    } else {
      console.log("▶ 3/4 跳过 token 种入（--no-seed-token）");
    }

    if (!noVerify) {
      console.log(`▶ 4/4 验证 http://127.0.0.1:${port} …`);
      await verifyApi(port, token);
      console.log("✔ /health + /api/v1/self/version ok");
    } else {
      console.log("▶ 4/4 跳过验证（--no-verify）");
    }

    console.log("");
    console.log("PTH 已就绪。");
    console.log(`  export PTH_API=http://127.0.0.1:${port}`);
    if (token) console.log(`  export PTH_TOKEN=${token}`);
    console.log("  验证: npm run pth -- status");
    if (token) console.log("  发任务: npm run pth -- submit \"任务描述\" --role developer");
  }

  function helpDown(): void {
    console.log("用法: npm run pth -- down [--env-file <path>] [--volumes]");
  }

  async function down(args: string[]): Promise<void> {
    if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
      helpDown();
      return;
    }
    const envFile = resolve(flag(args, "--env-file") ?? defaultSecrets);
    await requireSecrets(envFile);
    const compose = composeWith(envFile);
    const downArgs = ["down", "--remove-orphans", ...(hasFlag(args, "--volumes") ? ["--volumes"] : [])];
    console.log(`▶ docker compose ${downArgs.join(" ")} …`);
    await ensureCompose(downArgs, compose);
    console.log("✔ PTH 栈已停止。");
  }

  function helpStatus(): void {
    console.log("用法: npm run pth -- status [--env-file <path>] [--port <n>]");
    console.log("  （无 taskId 时显示栈健康；带 taskId 仍查询任务状态）");
  }

  async function status(args: string[]): Promise<void> {
    if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
      helpStatus();
      return;
    }
    const envFile = resolve(flag(args, "--env-file") ?? defaultSecrets);
    await requireSecrets(envFile);
    const compose = composeWith(envFile);
    const result = await ensureCompose(["ps", "--format", "json"], compose);
    const services = parseComposePs(result.stdout);
    if (services.length === 0) {
      console.log("PTH 栈未运行（docker compose ps 为空）。");
      return;
    }
    console.log("SERVICE".padEnd(16) + "STATE".padEnd(12) + "HEALTH");
    for (const service of services) {
      console.log(`${service.service.padEnd(16)}${service.state.padEnd(12)}${service.health ?? "-"}`);
    }
    const port = flagInt(args, "--port", 3000, 1, 65535);
    try {
      const text = await httpText(`http://127.0.0.1:${port}/health`);
      console.log(`API  http://127.0.0.1:${port}/health → ${text.trim()}`);
    } catch {
      console.log(`API  http://127.0.0.1:${port}/health → unreachable`);
    }
  }

  function helpLogs(): void {
    console.log("用法: npm run pth -- logs [service] [--tail <n>] [--follow] [--env-file <path>]");
  }

  async function logs(args: string[]): Promise<void> {
    if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
      helpLogs();
      return;
    }
    const envFile = resolve(flag(args, "--env-file") ?? defaultSecrets);
    await requireSecrets(envFile);
    const compose = composeWith(envFile);
    const tail = flagInt(args, "--tail", 100, 1, 100_000);
    const follow = hasFlag(args, "--follow");
    const service = positional(args, ["--env-file", "--tail"]);
    const logArgs = ["logs", "--tail", String(tail), ...(follow ? ["--follow"] : []), ...(service ? [service] : [])];
    if (follow) {
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn("docker", ["compose", "--env-file", envFile, "-f", composeFile, ...logArgs], { stdio: "inherit" });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolvePromise() : reject(new PthLauncherError("COMPOSE_FAILED", `docker compose logs exited ${code}`)));
      });
      return;
    }
    const result = await ensureCompose(logArgs, compose);
    process.stdout.write(result.stdout || result.stderr);
  }

  function helpInit(): void {
    console.log("用法: npm run pth -- init [--force]");
    console.log(`  复制 ${SECRETS_EXAMPLE} → ${SECRETS_FILE} 并 chmod 600（已存在时需 --force）。`);
  }

  async function init(args: string[]): Promise<void> {
    if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
      helpInit();
      return;
    }
    try {
      await copyFile(exampleSecrets, defaultSecrets, hasFlag(args, "--force") ? undefined : 1);
      await chmod(defaultSecrets, 0o600);
    } catch (cause) {
      throw new PthLauncherError(
        "INIT_FAILED",
        `failed to initialize ${SECRETS_FILE}${hasFlag(args, "--force") ? "" : "（已存在？加 --force 覆盖）"}`,
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    console.log(`✔ 已写入 ${SECRETS_FILE}（chmod 600）`);
    console.log("  编辑该文件替换全部示例密钥，然后: npm run pth -- up");
  }

  return { up, down, status, logs, init };
}

export async function runPthUp(args: string[], options: PthLauncherOptions): Promise<void> {
  await createPthLauncher(options).up(args);
}
export async function runPthDown(args: string[], options: PthLauncherOptions): Promise<void> {
  await createPthLauncher(options).down(args);
}
export async function runPthStatus(args: string[], options: PthLauncherOptions): Promise<void> {
  await createPthLauncher(options).status(args);
}
export async function runPthLogs(args: string[], options: PthLauncherOptions): Promise<void> {
  await createPthLauncher(options).logs(args);
}
export async function runPthInit(args: string[], options: PthLauncherOptions): Promise<void> {
  await createPthLauncher(options).init(args);
}
