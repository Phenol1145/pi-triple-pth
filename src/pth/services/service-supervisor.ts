/**
 * services/service-supervisor.ts —— host 服务进程监督器（pth services up/down/status/logs）。
 *
 * 约束：argv 数组 spawn（无 shell）；detached 进程 + pid/log 记录；健康轮询就绪；
 * pid 防误杀（down 前校验 entry.pid 仍指向存活进程）；日志上限截断。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync, truncateSync, readFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { pthConfig } from "../config/index.js";
import type { HostServiceManifest } from "./service-manifest.js";
import {
  defaultServiceLogDir,
  generateServiceToken,
  type HostServiceRuntimeEntry,
} from "./service-registry.js";

const MAX_LOG_BYTES = 10 * 1024 * 1024;

export interface UpServiceResult {
  child: ChildProcess;
  entry: HostServiceRuntimeEntry;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function extractPort(healthUrl: string): number {
  const m = /^http:\/\/127\.0\.0\.1:(\d{1,5})\//.exec(healthUrl);
  if (!m) throw new Error(`invalid healthUrl: ${healthUrl}`);
  return Number(m[1]);
}

function ensureLogFile(id: string): string {
  const dir = defaultServiceLogDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.log`);
  if (!existsSync(file)) {
    const fd = openSync(file, "a");
    closeSync(fd);
  }
  if (statSync(file).size > MAX_LOG_BYTES) truncateSync(file, 0);
  return file;
}

async function waitHealthy(url: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return;
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`service health check timeout after ${timeoutMs}ms: ${url}`);
}

export async function upHostService(
  manifest: HostServiceManifest,
  input: { token: string; logFile?: string },
): Promise<UpServiceResult> {
  const port = extractPort(manifest.healthUrl);
  if (!input.token || input.token.length < 16) throw new Error(`${manifest.id}: token 缺失（先经 registry 生成本地 token）`);
  const logFile = input.logFile ?? ensureLogFile(manifest.id);
  const logFd = openSync(logFile, "a");

  const env: NodeJS.ProcessEnv = { ...process.env, [manifest.tokenEnv]: input.token };
  let execRoot: string | undefined;
  if (manifest.pathMapping) {
    execRoot = process.env[manifest.pathMapping.execRootEnv];
    if (!execRoot) throw new Error(`${manifest.id}: pathMapping.execRootEnv ${manifest.pathMapping.execRootEnv} 未设置`);
    // ptl local-exec 的映射注入面：LOCAL_EXEC_PATH_MAPPINGS=[{hostRoot,execRoot}]
    env.LOCAL_EXEC_PATH_MAPPINGS = JSON.stringify([{ hostRoot: manifest.pathMapping.hostRoot, execRoot }]);
  }

  const command = [...manifest.command];
  if (command[0] === "ptl") {
    const ptlBin = pthConfig().str("PTH_PTL_BIN");
    if (ptlBin) command[0] = ptlBin;
  }

  const child = spawn(command[0]!, command.slice(1), {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
  });
  closeSync(logFd);
  child.unref(); // 监督器 CLI 不因 detached 子进程驻留
  const startedAt = Date.now();
  try {
    await waitHealthy(manifest.healthUrl, manifest.readyTimeoutMs ?? 30_000);
  } catch (error) {
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    throw error;
  }
  if (child.pid === undefined || !pidAlive(child.pid)) {
    throw new Error(`${manifest.id}: process exited during startup（见 ${logFile}）`);
  }
  return {
    child,
    entry: {
      id: manifest.id,
      url: `http://127.0.0.1:${port}`,
      port,
      token: input.token,
      pid: child.pid,
      startedAt,
      logFile,
      ...(manifest.pathMapping && execRoot
        ? { pathMapping: { hostRoot: manifest.pathMapping.hostRoot, execRoot } }
        : {}),
    },
  };
}

export async function downHostService(entry: HostServiceRuntimeEntry, graceMs = 5_000): Promise<void> {
  if (!pidAlive(entry.pid)) return;
  try { process.kill(entry.pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(entry.pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  try { process.kill(entry.pid, "SIGKILL"); } catch { /* 已退出 */ }
}

export async function statusHostService(entry: HostServiceRuntimeEntry): Promise<{ running: boolean; healthy: boolean; detail: string }> {
  if (!pidAlive(entry.pid)) return { running: false, healthy: false, detail: `pid ${entry.pid} 不存活` };
  try {
    const res = await fetch(`${entry.url}/health`, { signal: AbortSignal.timeout(2_000) });
    if (res.ok) return { running: true, healthy: true, detail: "ok" };
    return { running: true, healthy: false, detail: `health HTTP ${res.status}` };
  } catch (error) {
    return { running: true, healthy: false, detail: `health 探测失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function tailServiceLog(entry: HostServiceRuntimeEntry, lines: number): string {
  if (!existsSync(entry.logFile)) return "";
  const text = readFileSync(entry.logFile, "utf8");
  const all = text.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

export { generateServiceToken };
