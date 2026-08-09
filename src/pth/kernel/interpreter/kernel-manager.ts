/**
 * kernel-manager.ts — KernelManager 多语言 REPL 路由层（多语言 REPL 草案 T3）
 *
 * 统一执行入口：按 language 路由到对应 kernel；支持持久 kernel（PyKernel/BashKernel）
 * 与沙箱模式（PythonInterpreter/BashInterpreter）选择；每个 kernel 内 FIFO 队列串行。
 *
 * 并发模型（草案 §5.1-5.3）：
 *   - 每 worker 持有一个 KernelManager（per-worker 归属 v1）
 *   - kernel 内部 FIFO 队列（单执行循环天然串行安全）
 *   - 超时 kill + 冷备补位（由 PyKernel/BashKernel 内部实现）
 */

import type { ExecuteOptions, Interpreter, InterpreterResult, InterpreterSnapshot } from "./types.js";
import { TsInterpreter } from "./ts-interpreter.js";
import { PythonInterpreter } from "./python-interpreter.js";
import { BashInterpreter } from "./bash-interpreter.js";
import { PyKernel } from "./py-kernel.js";
import { BashKernel } from "./bash-kernel.js";
import { SandboxKernel } from "./sandbox-kernel.js";
import { SandboxCompiledKernel } from "./sandbox-compiled-kernel.js";
import { buildCapabilities } from "./capability.js";
import type { LlmFn } from "./llm-fn.js";
import type { DataWorldAccess } from "../storage/index.js";

export interface KernelManagerOptions {
  /** python 执行模式：kernel（持久管道，默认）| interpreter（每次 spawn）| sandbox-kernel（宿主池） */
  pythonMode?: "kernel" | "interpreter" | "sandbox-kernel";
  /** bash 执行模式：kernel（本地持久会话）| interpreter（sandbox 转发）| sandbox-kernel（宿主池） */
  bashMode?: "kernel" | "interpreter" | "sandbox-kernel";
  pythonBin?: string;
  sandbox?: { exec(req: any, signal?: AbortSignal): Promise<any> };
  /** sandbox-kernel 模式：宿主连接（kernel sandbox SPEC §3.3） */
  sandboxKernel?: { url: string; secret: string };
  /** 编译核（C 等——sandbox 侧编译-运行；cc 变体 gcc|clang|tcc 缺省 auto） */
  compiledCc?: "gcc" | "clang" | "tcc";
  /** 日志（日志体系 T4）：kernel stderr 转发 warn */
  onKernelStderr?: (language: string, line: string) => void;
  /** 性能计量（SPEC L1）：kernel 执行事件（batch 内经 IPC 转发主进程） */
  onKernelMetric?: (metric: { type: string; language: string; durationMs?: number; ok?: boolean; field?: string; count?: number; depth?: number }) => void;
  /** kernel 参数化（懒 spawn/空闲回收/reset 模式——PTH_KERNEL_* env 加载） */
  kernelConfig?: import("./kernel-config.js").KernelConfig;
}

export interface KernelManager {
  /** 统一执行入口：按 language 路由（ts | python | bash） */
  execute(language: string, program: string, opts?: ExecuteOptions): Promise<InterpreterResult>;
  /** 各语言 kernel 句柄（任务代码可直取：python.execute/bash.execute/c.execute 兼容） */
  python: Interpreter;
  bash: Interpreter;
  c: Interpreter;
  ts: Interpreter;
  reset(): void;
  dispose(): void;
}

/**
 * 创建 KernelManager：三语言统一路由。
 * 与 createWorkerKernel 的集成：worker 的 ts 能力注入依赖 python/bash 句柄——
 * 由调用方先建 manager 再 buildCapabilities（见 createWorkerKernelWithManager）。
 */
export function createKernelManager(opts: KernelManagerOptions): KernelManager {
  const pythonMode = opts.pythonMode ?? "kernel";
  const bashMode = opts.bashMode ?? "kernel";

  const python: Interpreter = pythonMode === "kernel"
    ? new PyKernel({ pythonBin: opts.pythonBin, onStderr: opts.onKernelStderr ? (l) => opts.onKernelStderr!("python", l) : undefined, ...opts.kernelConfig })
    : pythonMode === "sandbox-kernel"
      ? new SandboxKernel({ url: opts.sandboxKernel!.url, secret: opts.sandboxKernel!.secret, language: "python" })
      : new PythonInterpreter({ pythonBin: opts.pythonBin });

  const bash: Interpreter = bashMode === "kernel"
    ? new BashKernel({ onStderr: opts.onKernelStderr ? (l) => opts.onKernelStderr!("bash", l) : undefined, ...opts.kernelConfig })
    : bashMode === "sandbox-kernel"
      ? new SandboxKernel({ url: opts.sandboxKernel!.url, secret: opts.sandboxKernel!.secret, language: "bash" })
      : new BashInterpreter({
        sandbox: opts.sandbox ?? { exec: async () => ({ ok: false, stdout: "", stderr: "sandbox not configured", exitCode: 1, durationMs: 0 }) },
      });

  // 编译核（C——只在 sandbox 编译运行：用户架构裁决 2026-08-09；无 sandbox 连接时不可用降级错误）
  const compiled: Interpreter = opts.sandboxKernel
    ? new SandboxCompiledKernel({ url: opts.sandboxKernel.url, secret: opts.sandboxKernel.secret, cc: opts.compiledCc })
    : {
        language: "c",
        state: {},
        execute: async () => ({ ok: false, error: { message: "c kernel: sandbox 未配置（编译核只在 sandbox 运行）" }, durationMs: 0 }),
        reset() {}, dispose() {},
        snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      };

  const ts = new TsInterpreter({ capabilities: {} });  // capabilities 由 createWorkerKernel 注入（见下）

  // 包装计量（SPEC L1）：任务代码直调 python.execute/bash.execute 也计入 kernel 指标
  const metered = (interp: Interpreter, language: string): Interpreter => {
    if (!opts.onKernelMetric) return interp;
    return {
      ...interp,
      language: interp.language,
      snapshot: () => interp.snapshot(),   // 显式转发（spread 丢 prototype 方法）
      reset: () => interp.reset(),
      dispose: () => interp.dispose(),
      async execute(program, executeOpts) {
        const start = Date.now();
        const result = await interp.execute(program, executeOpts);
        opts.onKernelMetric!({ type: "exec", language, durationMs: Date.now() - start, ok: result.ok });
        if (result.truncated) opts.onKernelMetric!({ type: "truncated", language, field: result.truncated.field });
        return result;
      },
    };
  };

  return {
    execute: async (language, program, executeOpts) => {
      const start = Date.now();
      let result: InterpreterResult;
      switch (language) {
        case "ts": result = await ts.execute(program, executeOpts); break;
        case "python": result = await python.execute(program, executeOpts); break;
        case "bash": result = await bash.execute(program, executeOpts); break;
        case "c": result = await compiled.execute(program, executeOpts); break;
        default: return { ok: false, error: { message: `unknown language: ${language}` }, durationMs: 0 };
      }
      // 性能计量（SPEC L1）：执行事件 → 回调（batch 内经 IPC 转发主进程）
      opts.onKernelMetric?.({
        type: "exec", language, durationMs: Date.now() - start, ok: result.ok,
      });
      if (result.truncated) {
        opts.onKernelMetric?.({ type: "truncated", language, field: result.truncated.field });
      }
      return result;
    },
    python: metered(python, "python"),
    bash: metered(bash, "bash"),
    c: compiled,
    ts,
    reset() { ts.reset(); bash.reset(); python.reset(); compiled.reset(); },
    dispose() { ts.dispose(); bash.dispose(); python.dispose(); compiled.dispose(); },
  };
}

/**
 * 完整 worker kernel 装配（KernelManager 版）：
 * 能力注入（llm/memory/web/tasks）→ ts kernel 建在能力之上；python/bash 用 manager 的持久 kernel。
 * 任务代码用法不变：llm.* / memory.* / web.* / python.execute / bash.execute / ts 内联。
 */
export function createWorkerKernelWithManager(deps: {
  llm: LlmFn;
  dataWorld: DataWorldAccess;
  manager: KernelManager;
  /** toolstore 文件通道（§0.5）：注入 fs.readText */
  toolstore?: import("./toolstore.js").Toolstore;
}): {
  ts: TsInterpreter;
  python: Interpreter;
  bash: Interpreter;
  c: Interpreter;
  llm: LlmFn;
  dataWorld: DataWorldAccess;
  /** capability 白名单（web/state/fs/memory）——agent 循环与 vm 注入同一份 */
  capabilities: Record<string, unknown>;
  snapshot(): InterpreterSnapshot | Promise<InterpreterSnapshot>;
  reset(): void;
  dispose(): void;
} {
  const capabilities = buildCapabilities({
    llm: deps.llm,
    dataWorld: deps.dataWorld,
    bash: deps.manager.bash,
    python: deps.manager.python,
    c: deps.manager.c,
    toolstore: deps.toolstore,
    // 环境感知（env.inspect）：LLM 友好摘要——过滤 _ 私有项 + 值截断（不 dump 大对象）
    inspect: async (lang?: string) => {
      const snap = lang === "python"
        ? await deps.manager.python.snapshot()
        : lang === "bash"
          ? await deps.manager.bash.snapshot()
          : await ts.snapshot();
      return {
        language: lang ?? "ts",
        variables: snap.variables.filter((v) => !v.key.startsWith("_")).slice(0, 50).map((v) => ({ key: v.key, type: typeof v.value })),
        functions: snap.functions.filter((f) => !f.key.startsWith("_")).slice(0, 50).map((f) => ({ key: f.key, source: f.source.slice(0, 200) })),
      };
    },
  });
  const ts = new TsInterpreter({ capabilities });
  return {
    ts,
    capabilities,
    python: deps.manager.python,
    bash: deps.manager.bash,
    c: deps.manager.c,
    llm: deps.llm,
    dataWorld: deps.dataWorld,
    snapshot: async () => {
      const tsSnap = await ts.snapshot();
      const pySnap = await deps.manager.python.snapshot();
      const bSnap = await deps.manager.bash.snapshot();
      return {
        variables: [...tsSnap.variables, ...pySnap.variables],
        functions: [...tsSnap.functions, ...pySnap.functions],
        oversized: [...tsSnap.oversized, ...pySnap.oversized, ...bSnap.oversized],
      };
    },
    reset() { ts.reset(); deps.manager.reset(); },
    dispose() { ts.dispose(); deps.manager.dispose(); },
  };
}
