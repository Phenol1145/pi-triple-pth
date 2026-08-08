import { spawn } from "node:child_process";
import type { ExecuteOptions, Interpreter, InterpreterResult } from "./types.js";

export const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;

/**
 * Python 解释器：子进程执行（v1 无状态——每次新进程）。
 * 持久 REPL 留 v2；使用边界：单次脚本执行（对抗性审核 I6）。
 */
export class PythonInterpreter implements Interpreter {
  readonly language = "python";
  private pythonBin: string;
  private timeoutMs: number;

  constructor(deps: { pythonBin?: string; timeoutMs?: number }) {
    this.pythonBin = deps.pythonBin ?? "python3";
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
  }

  get state(): Record<string, unknown> {
    return {};  // v1 无持久状态
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const start = Date.now();
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    return new Promise<InterpreterResult>((resolve) => {
      const child = spawn(this.pythonBin, ["-c", program], {
        cwd: opts?.cwd,
        env: { ...process.env, ...(opts?.env ?? {}) },
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");   // 杀进程（单进程场景；进程组留 v2）
        resolve({ ok: false, error: { message: `python execution timed out after ${timeoutMs}ms` }, stdout, stderr, durationMs: Date.now() - start });
      }, timeoutMs);

      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout, stderr, durationMs: Date.now() - start });
      });
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: { message: e.message }, stdout, stderr, durationMs: Date.now() - start });
      });
    });
  }

  snapshot() {
    return { variables: [], functions: [], oversized: [] };  // v1 无状态
  }

  reset(): void {}
  dispose(): void {}
}
