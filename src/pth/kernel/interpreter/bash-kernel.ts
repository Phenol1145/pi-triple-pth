/**
 * bash-kernel.ts — Bash 持久 REPL kernel（多语言 REPL 草案 T2）
 *
 * 本地持久 shell 会话（spawn bash）+ 结束标记协议：
 *   - cwd/env/变量跨命令保留（真持久会话，非 Node 侧记忆）
 *   - 结束标记：命令后 echo __BASH_DONE_$?__（退出码捕获）
 *   - 超时 kill：死循环命令 → kill 会话 → 重启
 *   - reset：重启会话
 *
 * 生产注意：本 kernel 是【本地】持久会话（开发/测试/无沙箱环境）。
 * 沙箱隔离场景继续用 BashInterpreter（sandbox /exec 无状态转发）——
 * 两者都实现 Interpreter 接口，由 KernelManager 按环境选择。
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ExecuteOptions, Interpreter, InterpreterResult, InterpreterSnapshot } from "./types.js";

export const DEFAULT_BASH_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_STDOUT = 2 * 1024;
const DEFAULT_MAX_STDERR = 2 * 1024;
const DEFAULT_CWD = process.env.HOME ?? "/";

export class BashKernel implements Interpreter {
  readonly language = "bash";
  private child: ChildProcess | null = null;
  private buffer = "";
  private stderrBuf = "";
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private onStderr?: (line: string) => void;
  private pending: Array<{ resolve: (r?: { stdout: string; stderr: string; code: number | null }) => void }> = [];
  private cwd = DEFAULT_CWD;
  private env: Record<string, string> = {};
  private timeoutMs: number;
  private lazySpawn = true;
  private lastUsedAt = Date.now();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: {
    timeoutMs?: number;
    initialCwd?: string;
    onStderr?: (line: string) => void;
    /** 懒 spawn（默认 true）：构造不起进程，首次 execute 才 spawn */
    lazySpawn?: boolean;
    /** 空闲回收（默认 5min）：无调用超时 kill（0=禁用） */
    idleMs?: number;
  } = {}) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
    if (deps.initialCwd) this.cwd = deps.initialCwd;
    this.onStderr = deps.onStderr;
    this.lazySpawn = deps.lazySpawn ?? true;
    if (!this.lazySpawn) this.spawn();
    if ((deps.idleMs ?? 0) > 0) this.startIdleReaper(deps.idleMs!);
  }

  get state(): Record<string, unknown> {
    return { cwd: this.cwd, env: this.env };
  }

  reset(): void {
    this.kill();
    this.cwd = DEFAULT_CWD;
    this.env = {};
    if (!this.lazySpawn) this.spawn();   // 懒模式：execute 兜底重新 spawn
  }

  snapshot(): InterpreterSnapshot {
    // 会话配置（cwd/env）——非知识型状态（持久化层判定），v1 空快照
    return { variables: [], functions: [], oversized: [] };
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const start = Date.now();
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const maxStdout = opts?.maxStdout ?? DEFAULT_MAX_STDOUT;
    const maxStderr = opts?.maxStderr ?? DEFAULT_MAX_STDERR;

    if (!this.child || this.child.exitCode !== null) this.spawn();
    this.lastUsedAt = Date.now();

    try {
      // 等会话就绪（spawn 后立即执行会丢命令）
      await this.waitReady(2_000);
      const res = await this.run(program, timeoutMs);
      const out: InterpreterResult = {
        ok: res.code === 0,
        stdout: res.stdout,
        stderr: res.stderr,
        durationMs: Date.now() - start,
        language: "bash",
      };
      if (res.code !== null && res.code !== 0) {
        out.error = { message: `exit code ${res.code}`, code: `exit-${res.code}` };
      }
      // 截断（Observation §2.4.4）
      if (out.stdout && out.stdout.length > maxStdout) {
        out.truncated = { field: "stdout", originalLen: out.stdout.length, keptLen: maxStdout };
        out.stdout = out.stdout.slice(0, maxStdout);
      }
      if (out.stderr && out.stderr.length > maxStderr) {
        if (!out.truncated) out.truncated = { field: "stderr", originalLen: out.stderr.length, keptLen: maxStderr };
        out.stderr = out.stderr.slice(0, maxStderr);
      }
      return out;
    } catch (e) {
      // 超时/管道错误——kill 重启
      this.kill();
      this.spawn();
      return { ok: false, error: { message: (e as Error).message }, durationMs: Date.now() - start, language: "bash" };
    }
  }

  dispose(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.kill();
  }

  // ── 内部 ─────────────────────────────────────────────────

  /** 空闲回收：超过 idleMs 无调用 kill 进程（execute 自动冷备补位） */
  private startIdleReaper(idleMs: number): void {
    this.idleTimer = setInterval(() => {
      if (this.child && this.child.exitCode === null && Date.now() - this.lastUsedAt > idleMs) {
        this.kill();
      }
    }, Math.min(idleMs, 30_000));
    this.idleTimer.unref?.();
  }

  private spawn(): void {
    // 非交互模式：bash 读 stdin 逐行执行（不输出提示符，无 job control 噪音）
    const child = spawn("bash", ["--noprofile", "--norc"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });
    this.child = child;
    this.buffer = "";
    this.stderrBuf = "";
    this.ready = false;
    child.stdout.on("data", (d: Buffer) => this.onData(d.toString(), false));
    child.stderr.on("data", (d: Buffer) => this.onData(d.toString(), true));
    child.on("error", () => { /* 由 pending reject 兜底 */ });
    child.on("exit", () => {
      const pending = this.pending;
      this.pending = [];
      this.ready = false;
      for (const p of pending) p.resolve({ stdout: "", stderr: "bash session exited", code: 1 });
    });
    // 就绪探测：空命令（:）触发 marker，标志会话可用
    this.probeReady();
  }

  /** 就绪探测：写无输出命令 : 并等 marker——会话可用后才接受业务请求 */
  private probeReady(): void {
    const child = this.child;
    if (!child?.stdin || !child.stdin.writable) return;
    const entry = {
      resolve: () => {
        this.ready = true;
        const w = this.readyWaiters.splice(0);
        for (const fn of w) fn();
      },
    };
    this.pending.push(entry);
    child.stdin.write(":\necho __BASH_DONE_$?__\n");
  }

  private waitReady(timeoutMs: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      this.readyWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  private kill(): void {
    const old = this.child;
    if (old) {
      // 移除旧会话的 exit handler（防误 reject 新会话的 pending）
      old.removeAllListeners("exit");
      old.removeAllListeners("error");
      try { old.kill("SIGKILL"); } catch { /* ignore */ }
      this.child = null;
    }
    this.buffer = "";
    this.stderrBuf = "";
    this.ready = false;
  }

  private onData(chunk: string, isStderr: boolean): void {
    if (isStderr) {
      // kernel 自身 stderr（日志体系 T4）：无 pending 请求时输出 = 空闲错误（转发 warn）；
      // 有 pending 时是任务输出（Observation 已捕获，不转发防双写）
      if (this.pending.length === 0 && this.onStderr) {
        this.onStderr(chunk.toString());
      }
      this.stderrBuf += chunk;
    } else {
      this.buffer += chunk;
    }
    // 结束标记：在两个流里都找
    const markerRe = /__BASH_DONE_(\d+|-?\d+)__/;
    const src = this.buffer + this.stderrBuf;
    const m = src.match(markerRe);
    if (!m) return;
    const code = parseInt(m[1]!, 10);
    // 先切 marker（从各自 buffer），再取输出
    let stdoutPart = this.buffer;
    let stderrPart = this.stderrBuf;
    if (this.buffer.includes(m[0])) {
      stdoutPart = this.buffer.slice(0, this.buffer.indexOf(m[0]));
      this.buffer = this.buffer.slice(this.buffer.indexOf(m[0]) + m[0].length);
    }
    if (this.stderrBuf.includes(m[0])) {
      stderrPart = this.stderrBuf.slice(0, this.stderrBuf.indexOf(m[0]));
      this.stderrBuf = this.stderrBuf.slice(this.stderrBuf.indexOf(m[0]) + m[0].length);
    }
    const p = this.pending.shift();
    if (!p) return;
    p.resolve({ stdout: stdoutPart.replace(/\n*$/, ""), stderr: stderrPart.replace(/\n*$/, ""), code });
  }

  private run(program: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const child = this.child;
    if (!child?.stdin || !child.stdin.writable) {
      return Promise.reject(new Error("bash session not writable"));
    }
    return new Promise((resolve, reject) => {
      const entry: { resolve: (r?: { stdout: string; stderr: string; code: number | null }) => void } = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r!);
        },
      };
      const timer = setTimeout(() => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error(`bash execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.push(entry);
      // 命令 + 结束标记（独立行——分号同行会语法错误；多行脚本后换行执行标记）
      child.stdin!.write(`${program}\necho __BASH_DONE_$?__\n`);
    });
  }
}
