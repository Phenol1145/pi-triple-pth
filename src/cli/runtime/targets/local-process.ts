/**
 * runtime/targets/local-process.ts —— 无 Docker 单机信任域 target。
 *
 * 边界（W4 文档同步）：
 * - 仅支持仓库 checkout（engine/sandbox dist 需先 `npm run build`）；
 * - 外部供给 REDIS_URL / DATABASE_URL（doctor TCP 探活，up/down 不托管生命周期）；
 * - sandbox 二选一：`process`（本地 node 子进程）/ `none`（关闭 sandbox，本地 REPL 池）；
 * - 首次 up 需一次性信任域声明（orchestrator 负责交互确认）。
 */
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Redis } from "ioredis";
import {
  DEFAULT_RUN_DIR,
  detachedStatus,
  spawnDetached,
  stopDetached,
} from "../process-supervisor.js";
import { seedOperatorTokenViaRedis, type TokenSeedClient } from "../token-seed.js";
import type { DeployTarget, TargetContext } from "./types.js";

export interface LocalProcessDeps {
  runDir?: string;
  spawnDetached?: typeof spawnDetached;
  stopDetached?: typeof stopDetached;
  detachedStatus?: typeof detachedStatus;
  createRedisClient?: (url: string) => TokenSeedClient;
  fetchLike?: typeof fetch;
  randomToken?: () => string;
}

export interface ExecBackendEntry {
  id: string;
  url: string;
  profile: string;
  tokenEnv: string;
  required?: boolean;
}

export function buildExecBackends(opts: {
  sandbox: "process" | "none";
  includeLean: boolean;
  includeU8: boolean;
}): string {
  const backends: ExecBackendEntry[] = [];
  if (opts.sandbox === "process") {
    backends.push({
      id: "sandbox",
      url: "http://127.0.0.1:8080",
      profile: "sandbox-untrusted",
      tokenEnv: "SANDBOX_SHARED_SECRET",
      required: true,
    });
  }
  if (opts.includeLean) {
    backends.push({
      id: "local-lean",
      url: "http://127.0.0.1:8787",
      profile: "host",
      tokenEnv: "LOCAL_EXEC_SHARED_SECRET",
      required: false,
    });
  }
  if (opts.includeU8) {
    backends.push({
      id: "local-u8",
      url: "http://127.0.0.1:8788",
      profile: "host",
      tokenEnv: "LOCAL_EXEC_SHARED_SECRET",
      required: false,
    });
  }
  return JSON.stringify(backends);
}

export function parseUrlHostPort(raw: string, defaultPort: number): { host: string; port: number } {
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `redis://${raw}`;
  const url = new URL(withScheme);
  const host = url.hostname || "127.0.0.1";
  const port = url.port ? Number(url.port) : defaultPort;
  return { host, port };
}

async function httpOk(url: string, fetchLike: typeof fetch, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetchLike(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHttp(url: string, fetchLike: typeof fetch, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await httpOk(url, fetchLike, 1_000)) return;
    if (Date.now() > deadline) throw new Error(`等待 ${url} 超时`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function generatedToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * local-process 首次 up 信任域声明。`--yes-i-know` 直接跳过；TTY 下交互确认；
 * 非 TTY 且未带 flag → 报错。确认后写 `~/.pi-triple/local-process-ack`，后续不再重复打扰。
 */
export async function confirmLocalProcessTrust(opts: {
  yes: boolean;
  stdinIsTTY?: boolean;
  log?: (line: string) => void;
  ackFile?: string;
}): Promise<void> {
  const ackFile = opts.ackFile ?? join(homedir(), ".pi-triple", "local-process-ack");
  if (opts.yes) {
    await mkdir(dirname(ackFile), { recursive: true });
    await writeFile(ackFile, "ok\n");
    return;
  }
  try {
    await readFile(ackFile, "utf8");
    return;
  } catch {
    // 尚未确认
  }
  const log = opts.log ?? ((line: string) => console.error(line));
  log("⚠️ local-process 信任域声明：无容器隔离 / sandbox 零出口契约不成立 / PTH_CONFIG_STRICT 默认关");
  if (opts.stdinIsTTY ?? process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question("输入 yes 继续：");
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") {
      throw new Error("已取消 local-process 启动（可用 --yes-i-know 跳过确认）");
    }
  } else {
    throw new Error("local-process 需要信任域确认：非 TTY 请加 --yes-i-know");
  }
  await mkdir(dirname(ackFile), { recursive: true });
  await writeFile(ackFile, "ok\n");
}

export function createLocalProcessTarget(deps: LocalProcessDeps = {}): DeployTarget {
  const runDir = deps.runDir ?? DEFAULT_RUN_DIR;
  const spawn = deps.spawnDetached ?? spawnDetached;
  const stop = deps.stopDetached ?? stopDetached;
  const status = deps.detachedStatus ?? detachedStatus;
  const fetchLike = deps.fetchLike ?? fetch;
  const randomToken = deps.randomToken ?? generatedToken;
  const createRedisClient = deps.createRedisClient ?? ((url: string) => new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  }) as unknown as TokenSeedClient);

  async function startSandbox(ctx: TargetContext): Promise<void> {
    const entry = join(ctx.repoRoot, "packages", "pth-sandbox", "dist", "main.js");
    try {
      await access(entry);
    } catch {
      throw new Error(`sandbox dist 缺失: ${entry}（local-process v1 仅支持仓库 checkout；请先 npm run build）`);
    }
    const current = await status("pth-sandbox", { runDir });
    if (current.running) {
      ctx.log(`✔ sandbox 已在运行（pid=${current.pid}），跳过启动`);
      return;
    }
    const presets = localProcessTarget.envPresets({
      sandbox: ctx.sandbox,
      workspacesHost: ctx.env.PTH_WORKSPACES_HOST ?? ctx.env.PTH_WORKSPACES_PATH,
    });
    const env = { ...presets, ...ctx.env };
    const result = await spawn({
      name: "pth-sandbox",
      cmd: process.execPath,
      args: [entry],
      env,
      runDir,
      cwd: ctx.repoRoot,
    });
    ctx.log(`✔ sandbox 已启动（pid=${result.pid}）`);
    await waitHttp("http://127.0.0.1:8080/ready", fetchLike, ctx.timeoutMs);
  }

  async function seedToken(ctx: TargetContext, token: string | undefined, tenant: string): Promise<void> {
    if (!token) return;
    const redisUrl = ctx.env.REDIS_URL;
    if (!redisUrl) throw new Error("local-process 需要 REDIS_URL（deploy/.env.pth.secrets 填写）");
    const client = createRedisClient(redisUrl);
    try {
      await seedOperatorTokenViaRedis(client, token, tenant);
    } finally {
      const maybeDisconnect = (client as unknown as { disconnect?: () => void }).disconnect;
      if (typeof maybeDisconnect === "function") maybeDisconnect.call(client);
    }
  }

  async function verifyEngine(ctx: TargetContext, token: string | undefined): Promise<void> {
    await waitHttp("http://127.0.0.1:3000/health", fetchLike, ctx.timeoutMs);
    if (token) {
      const res = await fetchLike("http://127.0.0.1:3000/api/v1/self/version", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`/api/v1/self/version 验证失败: ${res.status}`);
    }
  }

  const localProcessTarget: DeployTarget = {
    id: "local-process",
    envPresets(opts) {
      return {
        PTH_CONFIG_STRICT: "0",
        SANDBOX_URL: "http://127.0.0.1:8080",
        PTH_SANDBOX_KERNEL_URL: "http://127.0.0.1:8080",
        ...(opts.workspacesHost ? { PTH_WORKSPACES_PATH: opts.workspacesHost } : {}),
        PTH_COMPILED_CACHE_DIR: opts.compiledCacheDir ?? join(homedir(), ".pi-triple", "compiled-cache", "c"),
        ...(opts.sandbox === "process"
          ? { PTH_PYTHON_MODE: "sandbox-kernel", PTH_BASH_MODE: "sandbox-kernel", PTH_EXEC_SANDBOX_ALIAS: "on" }
          : { PTH_PYTHON_MODE: "kernel", PTH_BASH_MODE: "kernel", PTH_EXEC_SANDBOX_ALIAS: "off" }),
      };
    },
    async upData(ctx, services) {
      if (services.includes("sandbox")) {
        if (ctx.sandbox === "process") await startSandbox(ctx);
        else ctx.log("sandbox=none，跳过 sandbox 进程（PTH_EXEC_SANDBOX_ALIAS=off）");
      } else {
        ctx.log("外部数据层，跳过生命周期管理（doctor 已探活 REDIS_URL/DATABASE_URL）");
      }
    },
    async down(ctx) {
      await stop("pth-sandbox", { runDir });
      await stop("pth-engine", { runDir });
      ctx.log("✔ local-process 进程已停止（sandbox → engine 反向）");
    },
    async engineUp(ctx, forward) {
      const entry = join(ctx.repoRoot, "dist", "pth", "main.js");
      try {
        await access(entry);
      } catch {
        throw new Error(`engine dist 缺失: ${entry}（local-process v1 仅支持仓库 checkout；请先 npm run build）`);
      }
      const current = await status("pth-engine", { runDir });
      if (current.running) {
        ctx.log(`✔ engine 已在运行（pid=${current.pid}），跳过启动`);
        return;
      }

      const seed = !forward.includes("--no-seed-token");
      const explicitToken = flagValue(forward, "--token");
      const tenant = flagValue(forward, "--tenant") ?? "ops";
      const token = seed ? (explicitToken ?? randomToken()) : undefined;
      const presets = localProcessTarget.envPresets({
        sandbox: ctx.sandbox,
        workspacesHost: ctx.env.PTH_WORKSPACES_HOST ?? ctx.env.PTH_WORKSPACES_PATH,
      });
      const includeLean = ctx.components?.some((c) => c.id === "local-lean") ?? false;
      const includeU8 = ctx.components?.some((c) => c.id === "local-u8") ?? false;
      const env = {
        ...presets,
        ...ctx.env,
        PTH_EXEC_BACKENDS: buildExecBackends({ sandbox: ctx.sandbox, includeLean, includeU8 }),
      };

      const result = await spawn({
        name: "pth-engine",
        cmd: process.execPath,
        args: [entry],
        env,
        runDir,
        cwd: ctx.repoRoot,
      });
      ctx.log(`✔ engine 已启动（pid=${result.pid}）`);
      await verifyEngine(ctx, token);
      if (token) {
        ctx.log(`▶ 种入 operator token（tenant=${tenant}）…`);
        await seedToken(ctx, token, tenant);
        ctx.log("✔ operator token seeded");
      }
      if (token) ctx.log(`operator token: ${token}`);
    },
    async statusData(ctx) {
      const engine = await status("pth-engine", { runDir });
      const sandbox = await status("pth-sandbox", { runDir });
      const lines: string[] = [];
      lines.push(engine.running ? `  engine: running (pid=${engine.pid})` : "  engine: not running");
      lines.push(sandbox.running ? `  sandbox: running (pid=${sandbox.pid})` : "  sandbox: not running");
      return lines;
    },
  };

  return localProcessTarget;
}

export const localProcessTarget = createLocalProcessTarget();
