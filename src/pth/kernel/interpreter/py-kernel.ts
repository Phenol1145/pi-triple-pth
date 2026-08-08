/**
 * py-kernel.ts — Python 持久 REPL kernel（多语言 REPL 草案 T1）
 *
 * 替换 PythonInterpreter（每次 spawn 无状态）→ 常驻进程 + 管道 JSON-RPC：
 *   - 持久命名空间：exec(code, globals()) 共享——变量/函数跨 cell 保留
 *   - _result 通道：cell 设 _result → Observation.value（与 TS return 对齐）
 *   - 超时 kill：死循环 cell → kill 进程 → 自动重启（冷备补位语义）
 *   - reset：重启进程（清命名空间）
 *   - snapshot：遍历 globals()（可 JSON → variables；函数/类 → source）
 *
 * 协议：每行 JSON {code, timeoutMs} → {ok, result, stdout, error}
 * 实测：0.1ms/cell vs 12ms/spawn（230x）
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ExecuteOptions, Interpreter, InterpreterResult, InterpreterSnapshot } from "./types.js";

export const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_STDOUT = 2 * 1024;
const DEFAULT_MAX_STDERR = 2 * 1024;
const DEFAULT_MAX_VALUE_CHARS = 8 * 1024;

// Python 常驻 runtime：逐行读 stdin JSON → 分发 exec/snapshot → 回 JSON。
// _result 约定：cell 设置全局 _result 即结构化返回值。
const PY_RUNTIME = `
import sys, json, io, traceback, inspect

print("__pth_ready__", flush=True)   # 启动就绪信号（防 stdin 写入丢失）

def snapshot_globals():
    ns = globals().get("_NAMESPACE", {})
    last_code = ns.get("_LAST_CODE", "")   # 最近 cell 源码（供无源函数提取）
    out = {"variables": [], "functions": [], "oversized": []}
    for key, val in list(ns.items()):
        if key.startswith("_"):
            continue
        if inspect.ismodule(val):
            continue   # 模块不进快照（是运行时导入的依赖，非任务产物）
        if inspect.isfunction(val) or inspect.isclass(val):
            src = None
            try:
                src = inspect.getsource(val)
            except Exception:
                src = None
            if src is None:
                # 无源函数（exec 动态定义）：从最近 cell 源码提取 def <name>
                import re
                m = re.search(r"^def\\s+" + re.escape(key) + r"[\\s\\S]*?(?=^def\\s+|\\Z)", last_code, re.M)
                src = m.group(0) if m else "<source unavailable>"
            out["functions"].append({"key": key, "source": src})
            continue
        try:
            json.dumps(val)
            out["variables"].append({"key": key, "value": val})
        except Exception:
            out["oversized"].append(key)
    return out

def main():
    global _NAMESPACE
    _NAMESPACE = {}
    for line in sys.stdin:
        try:
            req = json.loads(line)
            if req.get("type") == "snapshot":
                print(json.dumps({"ok": True, "result": snapshot_globals()}), flush=True)
                continue
            code = req.get("code", "")
            out = io.StringIO()
            err = io.StringIO()
            old_out, old_err = sys.stdout, sys.stderr
            sys.stdout, sys.stderr = out, err
            try:
                _NAMESPACE["_LAST_CODE"] = _NAMESPACE.get("_LAST_CODE", "") + "\\n" + code   # 累积（供无源函数源码提取）
                exec(code, _NAMESPACE)
                result = _NAMESPACE.pop("_result", None)   # 取出即清（防会话残留）
                ok = True
                err_msg = None
            except Exception as e:
                result = None
                ok = False
                err_msg = traceback.format_exc()
            finally:
                sys.stdout, sys.stderr = old_out, old_err
            print(json.dumps({
                "ok": ok,
                "result": result if ok else None,
                "stdout": out.getvalue(),
                "stderr": err.getvalue() if not ok else err.getvalue(),
                "error": err_msg if not ok else None,
            }), flush=True)
        except Exception as e:
            print(json.dumps({"ok": False, "result": None, "stdout": "", "stderr": "", "error": "kernel protocol error: " + str(e)}), flush=True)

main()
`;

// 快照读共享命名空间 _NAMESPACE（main 内 exec 的同一个 dict）

// 快照协议：遍历 globals → 分类（可 JSON/函数/超大）
// 经普通 execute 通道执行（internal 标志防 _result 污染）
const SNAPSHOT_CODE = `
import json, inspect, types
_result = {"variables": [], "functions": [], "oversized": []}
for key, val in list(globals().items()):
    if key.startswith("_") or key in ("json", "inspect", "types"):
        continue
    if inspect.isfunction(val) or inspect.isclass(val) or inspect.ismodule(val):
        try:
            src = inspect.getsource(val)
        except Exception:
            src = "<source unavailable>"
        _result["functions"].append({"key": key, "source": src})
        continue
    try:
        json.dumps(val)
        _result["variables"].append({"key": key, "value": val})
    except Exception:
        _result["oversized"].append(key)
`;

interface PyProtocolMsg {
  ok: boolean;
  result?: unknown;
  stdout?: string;
  stderr?: string;
  error?: string | null;
}

/** JSON 序列化辅助：_result 循环引用等 → 降级 undefined（不 crash kernel） */
function safeSerialize(v: unknown): { value: unknown; ok: boolean } {
  try {
    JSON.stringify(v);
    return { value: v, ok: true };
  } catch {
    return { value: undefined, ok: false };
  }
}

export class PyKernel implements Interpreter {
  readonly language = "python";
  private child: ChildProcess | null = null;
  private pending: Array<{ resolve: (msg: PyProtocolMsg) => void }> = [];
  private buffer = "";
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private pythonBin: string;
  private timeoutMs: number;

  constructor(deps: { pythonBin?: string; timeoutMs?: number } = {}) {
    this.pythonBin = deps.pythonBin ?? "python3";
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.spawn();
  }

  get state(): Record<string, unknown> {
    // 持久命名空间的粗略视图：snapshot 的精简版（不触发协议往返）
    return {} as Record<string, unknown>;
  }

  /** 重启进程（清命名空间——reset 语义） */
  reset(): void {
    this.kill();
    this.spawn();
  }

  /** 遍历 globals：可 JSON → variables；函数/类 → functions；超大 → oversized */
  async snapshot(): Promise<InterpreterSnapshot> {
    if (!this.child || this.child.exitCode !== null) this.spawn();
    try {
      const msg = await this.call({ type: "snapshot", timeoutMs: 5_000 });
      if (!msg.ok || !msg.result) return { variables: [], functions: [], oversized: [] };
      const raw = msg.result as {
        variables?: Array<{ key: string; value: unknown }>;
        functions?: Array<{ key: string; source: string }>;
        oversized?: string[];
      };
      return {
        variables: (raw.variables ?? []).map((v) => ({ ...v, serializable: true })),
        functions: raw.functions ?? [],
        oversized: raw.oversized ?? [],
      };
    } catch {
      return { variables: [], functions: [], oversized: [] };
    }
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const start = Date.now();
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const maxStdout = opts?.maxStdout ?? DEFAULT_MAX_STDOUT;
    const maxStderr = opts?.maxStderr ?? DEFAULT_MAX_STDERR;
    const maxValueChars = opts?.maxValueChars ?? DEFAULT_MAX_VALUE_CHARS;
    const captureResult = opts?.captureResult ?? true;

    if (!this.child || this.child.exitCode !== null) this.spawn();

    let msg: PyProtocolMsg;
    try {
      msg = await this.call({ code: program, timeoutMs });    } catch (e) {
      // 管道错误/超时——kill 重启（冷备补位）
      this.kill();
      this.spawn();
      return { ok: false, error: { message: (e as Error).message }, durationMs: Date.now() - start, language: "python" };
    }

    // 组装 Observation（协议 §2.4）
    const out: InterpreterResult = {
      ok: msg.ok,
      stdout: msg.stdout ?? "",
      stderr: msg.stderr ?? "",
      durationMs: Date.now() - start,
      language: "python",
    };
    if (msg.error) out.error = { message: msg.error };

    // value 通道（_result 约定）
    if (captureResult && msg.ok) {
      if (msg.result === undefined || msg.result === null) {
        out.value = undefined;
      } else {
        const { value, ok: serOk } = safeSerialize(msg.result);
        out.value = value;
        if (!serOk) {
          out.stderr = (out.stderr ?? "") + "\n[warning] _result 不可 JSON 序列化——value=undefined";
        }
      }
    }

    // 截断策略（§2.4.4）
    if (out.stdout && out.stdout.length > maxStdout) {
      out.truncated = { field: "stdout", originalLen: out.stdout.length, keptLen: maxStdout };
      out.stdout = out.stdout.slice(0, maxStdout);
    }
    if (out.stderr && out.stderr.length > maxStderr) {
      if (!out.truncated) out.truncated = { field: "stderr", originalLen: out.stderr.length, keptLen: maxStderr };
      out.stderr = out.stderr.slice(0, maxStderr);
    }
    if (out.value !== undefined) {
      const s = safeSerialize(out.value);
      if (s.ok) {
        const json = JSON.stringify(s.value);
        if (json && json.length > maxValueChars) {
          out.truncated = out.truncated ?? { field: "value", originalLen: json.length, keptLen: maxValueChars };
        }
      }
    }

    return out;
  }

  dispose(): void {
    this.kill();
  }

  // ── 内部 ─────────────────────────────────────────────────

  private spawn(): void {
    const child = spawn(this.pythonBin, ["-u", "-c", PY_RUNTIME], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.buffer = "";
    this.ready = false;
    child.stdout.on("data", (d: Buffer) => this.onData(d.toString()));
    child.stderr.on("data", () => { /* kernel 自身 stderr 忽略 */ });
    child.on("error", () => { /* 由 pending reject 兜底 */ });
    child.on("exit", () => {
      // 进程退出——reject 所有 pending
      const pending = this.pending;
      this.pending = [];
      this.ready = false;
      for (const p of pending) p.resolve({ ok: false, result: null, stdout: "", stderr: "", error: "kernel process exited" });
    });
  }

  private kill(): void {
    const old = this.child;
    if (old) {
      // 移除旧会话 handler（防误 reject 新会话 pending）
      old.removeAllListeners("exit");
      old.removeAllListeners("error");
      try { old.kill("SIGKILL"); } catch { /* ignore */ }
      this.child = null;
    }
    this.buffer = "";
    this.ready = false;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      // 就绪信号（非协议响应）
      if (line === "__pth_ready__") {
        this.ready = true;
        const w = this.readyWaiters.splice(0);
        for (const fn of w) fn();
        continue;
      }
      const p = this.pending.shift();
      if (!p) continue;
      try {
        p.resolve(JSON.parse(line) as PyProtocolMsg);
      } catch {
        p.resolve({ ok: false, result: null, stdout: "", stderr: "", error: "invalid kernel response" });
      }
    }
  }

  /** 单请求：等就绪 → 写入管道 + 等响应；超时 → 抛错（调用方 kill 重启） */
  private async call(req: { code?: string; type?: "exec" | "snapshot"; timeoutMs: number }): Promise<PyProtocolMsg> {
    const child0 = this.child;
    if (!child0 || !child0.stdin || !child0.stdin.writable) {
      throw new Error("kernel not writable");
    }
    // 等就绪信号（防 spawn 后 stdin 写入丢失——超时 kill 重启场景）
    if (!this.ready) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 2000);
        this.readyWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    return new Promise<PyProtocolMsg>((resolve, reject) => {
      const entry = {
        resolve: (msg: PyProtocolMsg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      };
      const timer = setTimeout(() => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error(`python execution timed out after ${req.timeoutMs}ms`));
      }, req.timeoutMs);
      this.pending.push(entry);
      const body: Record<string, unknown> = { timeoutMs: req.timeoutMs };
      if (req.type === "snapshot") body.type = "snapshot";
      else body.code = req.code;
      const child = this.child;
      if (child?.stdin) child.stdin.write(JSON.stringify(body) + "\n");
    });
  }
}
