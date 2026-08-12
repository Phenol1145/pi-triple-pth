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
import { PTH_MEMORY_LIB_B64 } from "./pth-memory-lib.js";
import type { ExecuteOptions, Interpreter, InterpreterResult, InterpreterSnapshot } from "./types.js";

export const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_STDOUT = 2 * 1024;
const DEFAULT_MAX_STDERR = 2 * 1024;
const DEFAULT_MAX_VALUE_CHARS = 8 * 1024;

// Python 常驻 runtime：逐行读 stdin JSON → 分发 exec/snapshot → 回 JSON。
// _result 约定：cell 设置全局 _result 即结构化返回值。
export const PY_RUNTIME = `
import sys, json, io, traceback, inspect

print("__pth_ready__", flush=True)   # 启动就绪信号（防 stdin 写入丢失）

def snapshot_globals():
    ns = globals().get("_NAMESPACE", {})
    last_code = ns.get("_LAST_CODE", "")   # 最近 cell 源码（供无源函数提取）
    out = {"variables": [], "functions": [], "oversized": []}
    for key, val in list(ns.items()):
        if key.startswith("_"):
            continue
        if key == "memory":
            continue   # 记忆桥实例非序列化——固定 oversized 噪音（2026-08-12 审计）
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

_PTH_MEMORY_LIB_B64 = "__PTH_MEMORY_LIB_B64__"

def main():
    global _NAMESPACE
    _NAMESPACE = {}
    # 记忆库（2026-08-11 库化）：pth-memory-lib 独立模块源码（base64 注入——零转义）。
    # bridge URL 从 env PTH_MEMORY_BRIDGE 读（kernel 模式=localhost:3000 直通；sandbox=8080 转发）。
    import base64 as _b64
    # 显式 globals()——函数内 exec 的定义默认进不了局部作用域（CPython 局部优化）
    exec(_b64.b64decode(_PTH_MEMORY_LIB_B64).decode("utf-8"), globals())
    _NAMESPACE["memory"] = create_memory()
    for line in sys.stdin:
        try:
            req = json.loads(line)
            if req.get("type") == "snapshot":
                print(json.dumps({"ok": True, "result": snapshot_globals()}), flush=True)
                continue
            if req.get("type") == "clear":
                # ns reset：清命名空间不重启（进程复用——池化地基）
                # 保留 seed 键（ASP-5 记忆桥 memory 全局——清掉后后续调用 memory 未定义）
                for k in list(_NAMESPACE.keys()):
                    if k != "memory":
                        del _NAMESPACE[k]
                print(json.dumps({"ok": True, "result": None}), flush=True)
                continue
            code = req.get("code", "")
            mode = req.get("exec", "auto")   # 2026-08-11 元命令拆分：single=eval 表达式求值 / program=exec 程序
            out = io.StringIO()
            err = io.StringIO()
            old_out, old_err = sys.stdout, sys.stderr
            sys.stdout, sys.stderr = out, err
            try:
                if mode == "single":
                    # 单表达式求值：eval 返回表达式值（语句 → SyntaxError 显式报错——调用方负责单表达式）
                    result = eval(code, _NAMESPACE)
                    ok = True
                    err_msg = None
                else:
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
  private readonly memoryBridge: string = "http://localhost:8080/kernel/memory-bridge";
  private child: ChildProcess | null = null;
  private pending: Array<{ resolve: (msg: PyProtocolMsg) => void }> = [];
  private buffer = "";
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private onStderr?: (line: string) => void;
  private pythonBin: string;
  private timeoutMs: number;
  private resetMode: "ns" | "restart" = "ns";
  private lazySpawn = true;
  private lastUsedAt = Date.now();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: {
    pythonBin?: string;
    timeoutMs?: number;
    onStderr?: (line: string) => void;
    /** 懒 spawn（默认 true）：构造不起进程，首次 execute/snapshot 才 spawn——空闲角色 0 进程 */
    lazySpawn?: boolean;
    /** reset 语义（默认 ns）：ns=清命名空间不重启（进程复用）；restart=杀进程重启 */
    resetMode?: "ns" | "restart";
    /** 空闲回收（默认 5min）：无调用超时 kill（0=禁用）；execute/snapshot 自动冷备补位 */
    idleMs?: number;
    /** 记忆桥 URL（2026-08-11 库化——spawn env PTH_MEMORY_BRIDGE；缺省 sandbox 模式 8080 转发） */
    memoryBridge?: string;
  } = {}) {
    this.pythonBin = deps.pythonBin ?? "python3";
    this.memoryBridge = deps.memoryBridge ?? process.env.PTH_MEMORY_BRIDGE ?? "http://localhost:8080/kernel/memory-bridge";
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.onStderr = deps.onStderr;
    this.resetMode = deps.resetMode ?? "ns";
    this.lazySpawn = deps.lazySpawn ?? true;
    if (!this.lazySpawn) this.spawn();   // 非懒模式：构造即 spawn（兼容旧行为）
    if ((deps.idleMs ?? 0) > 0) this.startIdleReaper(deps.idleMs!);
  }

  get state(): Record<string, unknown> {
    // 持久命名空间的粗略视图：snapshot 的精简版（不触发协议往返）
    return {} as Record<string, unknown>;
  }

  /** 重启进程（清命名空间——reset 语义；ns 模式=协议清 ns 不重启，restart=杀进程重启） */
  reset(): void {
    if (this.resetMode === "ns" && this.child && this.child.exitCode === null) {
      // ns 模式：进程复用，命名空间清空。必须注册 pending entry（防响应错配——
      // 否则 clear 的响应被后续 execute 的 entry shift 走，execute 拿到 result=null）。
      void this.call({ type: "clear", timeoutMs: 2_000 }).catch(() => {
        // clear 失败（管道坏/超时）→ kill 冷备（execute 兜底重新 spawn）
        this.kill();
      });
      return;
    }
    this.kill();
    if (!this.lazySpawn) this.spawn();
  }

  /** 遍历 globals：可 JSON → variables；函数/类 → functions；超大 → oversized */
  async snapshot(): Promise<InterpreterSnapshot> {
    if (!this.child || this.child.exitCode !== null) this.spawn();
    this.touch();
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
    this.touch();

    let msg: PyProtocolMsg;
    try {
      msg = await this.call({ code: program, timeoutMs, ...(opts?.exec ? { exec: opts.exec } : {}) });    } catch (e) {
      // 管道错误/超时——kill 置空（冷备补位：下个 execute 懒 spawn——失败场景不二次 spawn 浪费）
      this.kill();
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
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.kill();
  }

  // ── 内部 ─────────────────────────────────────────────────

  /** 空闲回收：超过 idleMs 无调用 kill 进程（execute/snapshot 自动冷备补位） */
  private startIdleReaper(idleMs: number): void {
    this.idleTimer = setInterval(() => {
      if (this.child && this.child.exitCode === null && Date.now() - this.lastUsedAt > idleMs) {
        this.kill();
      }
    }, Math.min(idleMs, 30_000));
    this.idleTimer.unref?.();
  }

  private touch(): void {
    this.lastUsedAt = Date.now();
  }

  private spawn(): void {
    // 占位符校验（2026-08-12 审计）：错配时 python 侧 exec 抛 base64 解码错——启动即崩且难诊断
    if (!PY_RUNTIME.includes("__PTH_MEMORY_LIB_B64__")) throw new Error("PY_RUNTIME 缺失记忆库占位符（__PTH_MEMORY_LIB_B64__）");
    const runtime = PY_RUNTIME.replace("__PTH_MEMORY_LIB_B64__", PTH_MEMORY_LIB_B64);
    const child = spawn(this.pythonBin, ["-u", "-c", runtime], {
      stdio: ["pipe", "pipe", "pipe"],
      // 记忆桥 URL 注入（2026-08-11 库化——kernel 模式 localhost:3000 直通；sandbox kernel-pool 缺省 8080 转发）
      env: { ...process.env, PTH_MEMORY_BRIDGE: this.memoryBridge },
    });
    this.child = child;
    this.buffer = "";
    this.ready = false;
    child.stdout.on("data", (d: Buffer) => this.onData(d.toString()));
    child.stderr.on("data", (d: Buffer) => { this.onStderr?.(d.toString()); });
    child.on("error", (err) => {
      // 2026-08-12 审计修复：spawn 失败（ENOENT 等）只发 error+close 不发 exit——pending 会悬挂满 timeout。
      // error 即 reject 全部 pending（exit 路径仍兜底）
      const pending = this.pending;
      this.pending = [];
      this.ready = false;
      for (const p of pending) p.resolve({ ok: false, result: null, stdout: "", stderr: "", error: `kernel spawn failed: ${err.message}` });
    });
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
      try { old.kill("SIGKILL"); } catch (e) { }
      // stdio 销毁（2026-08-12 审计）：ENOENT 等失败场景进程已死但 pipe 句柄残留——
      // 事件循环不退出（vitest 挂住/批处理泄漏）——显式 destroy
      try { old.stdout?.destroy(); old.stderr?.destroy(); old.stdin?.destroy(); } catch (e) { }
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
  private async call(req: { code?: string; type?: "exec" | "snapshot" | "clear"; timeoutMs: number; exec?: "single" | "program" | "auto" }): Promise<PyProtocolMsg> {
    const child0 = this.child;
    if (!child0 || !child0.stdin || !child0.stdin.writable) {
      throw new Error("kernel not writable");
    }
    // 等就绪信号（防 spawn 后 stdin 写入丢失——超时 kill 重启场景）
    if (!this.ready) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { resolve(); }, 2000);
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
      else if (req.type === "clear") body.type = "clear";
      else {
        body.code = req.code;
        if (req.exec) body.exec = req.exec;   // 元命令拆分（2026-08-11）：single/program 透传 PY_RUNTIME
      }
      const child = this.child;
      if (child?.stdin) child.stdin.write(JSON.stringify(body) + "\n");
    });
  }
}
