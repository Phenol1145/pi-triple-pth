/**
 * runtime/process-supervisor.ts —— local-process 本地子进程生命周期管理。
 *
 * 每个组件在 `~/.pi-triple/run/<name>.{pid,log}` 留下 pidfile/log；down 时
 * SIGTERM → 5s 宽限 → SIGKILL，之后清 pidfile。不做跨重启守护（v2.0 范围）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_RUN_DIR = join(homedir(), ".pi-triple", "run");

export interface SpawnDetachedOpts {
  name: string;
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  runDir: string;
  cwd?: string;
  /** 测试注入 */
  spawnFn?: (cmd: string, args: string[], opts: Parameters<typeof spawn>[2]) => ChildProcess;
}

export type KillSignal = NodeJS.Signals | 0;

export interface StopDetachedOpts {
  runDir?: string;
  killFn?: (pid: number, signal: KillSignal) => boolean;
  signalWaitMs?: number;
}

export interface DetachedStatusOpts {
  runDir?: string;
  killFn?: (pid: number, signal: KillSignal) => boolean;
}

function pidPath(runDir: string, name: string): string {
  return join(runDir, `${name}.pid`);
}

function logPath(runDir: string, name: string): string {
  return join(runDir, `${name}.log`);
}

function defaultKill(pid: number, signal: KillSignal): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw err;
  }
}

function isAlive(pid: number, killFn: (pid: number, signal: KillSignal) => boolean): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    return killFn(pid, 0);
  } catch {
    return false;
  }
}

export async function spawnDetached(opts: SpawnDetachedOpts): Promise<{ pid: number }> {
  const runDir = opts.runDir;
  await mkdir(runDir, { recursive: true });
  const logFile = logPath(runDir, opts.name);
  await access(runDir).catch(() => mkdir(runDir, { recursive: true }));
  const logFd = await import("node:fs/promises").then((m) => m.open(logFile, "a"));
  try {
    const spawnFn = opts.spawnFn ?? spawn;
    const child = spawnFn(opts.cmd, opts.args, {
      detached: true,
      stdio: ["ignore", logFd.fd, logFd.fd],
      env: opts.env as Record<string, string>,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    child.unref();
    await writeFile(pidPath(runDir, opts.name), String(child.pid ?? -1));
    return { pid: child.pid ?? -1 };
  } finally {
    await logFd.close();
  }
}

export async function stopDetached(name: string, opts: StopDetachedOpts = {}): Promise<void> {
  const runDir = opts.runDir ?? DEFAULT_RUN_DIR;
  const killFn = opts.killFn ?? defaultKill;
  const signalWaitMs = opts.signalWaitMs ?? 5_000;
  const pidFile = pidPath(runDir, name);
  let pid: number;
  try {
    pid = Number((await readFile(pidFile, "utf8")).trim());
  } catch {
    return; // 无 pidfile = 未运行，幂等
  }
  if (!isAlive(pid, killFn)) {
    await unlink(pidFile).catch(() => undefined);
    return;
  }
  killFn(pid, "SIGTERM");
  const deadline = Date.now() + signalWaitMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid, killFn)) {
      await unlink(pidFile).catch(() => undefined);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isAlive(pid, killFn)) {
    killFn(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
  }
  await unlink(pidFile).catch(() => undefined);
}

export async function detachedStatus(name: string, opts: DetachedStatusOpts = {}): Promise<{ running: boolean; pid?: number }> {
  const runDir = opts.runDir ?? DEFAULT_RUN_DIR;
  const killFn = opts.killFn ?? defaultKill;
  const pidFile = pidPath(runDir, name);
  let pid: number;
  try {
    pid = Number((await readFile(pidFile, "utf8")).trim());
  } catch {
    return { running: false };
  }
  if (!isAlive(pid, killFn)) {
    await unlink(pidFile).catch(() => undefined);
    return { running: false };
  }
  return { running: true, pid };
}
