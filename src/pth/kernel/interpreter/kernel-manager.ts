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

import type { ExecuteOptions, Interpreter, InterpreterResult } from "./types.js";
import { TsInterpreter } from "./ts-interpreter.js";
import { PythonInterpreter } from "./python-interpreter.js";
import { BashInterpreter } from "./bash-interpreter.js";
import { PyKernel } from "./py-kernel.js";
import { BashKernel } from "./bash-kernel.js";
import { buildCapabilities } from "./capability.js";
import type { LlmFn } from "./llm-fn.js";
import type { DataWorldAccess } from "../storage/index.js";

export interface KernelManagerOptions {
  /** python 执行模式：kernel（持久管道，默认）| interpreter（每次 spawn） */
  pythonMode?: "kernel" | "interpreter";
  /** bash 执行模式：kernel（本地持久会话）| interpreter（sandbox 转发） */
  bashMode?: "kernel" | "interpreter";
  pythonBin?: string;
  sandbox?: { exec(req: any, signal?: AbortSignal): Promise<any> };
}

export interface KernelManager {
  /** 统一执行入口：按 language 路由（ts | python | bash） */
  execute(language: string, program: string, opts?: ExecuteOptions): Promise<InterpreterResult>;
  /** 各语言 kernel 句柄（任务代码可直取：python.execute/bash.execute 兼容） */
  python: Interpreter;
  bash: Interpreter;
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
    ? new PyKernel({ pythonBin: opts.pythonBin })
    : new PythonInterpreter({ pythonBin: opts.pythonBin });

  const bash: Interpreter = bashMode === "kernel"
    ? new BashKernel()
    : new BashInterpreter({
        sandbox: opts.sandbox ?? { exec: async () => ({ ok: false, stdout: "", stderr: "sandbox not configured", exitCode: 1, durationMs: 0 }) },
      });

  const ts = new TsInterpreter({ capabilities: {} });  // capabilities 由 createWorkerKernel 注入（见下）

  return {
    execute: async (language, program, executeOpts) => {
      switch (language) {
        case "ts": return ts.execute(program, executeOpts);
        case "python": return python.execute(program, executeOpts);
        case "bash": return bash.execute(program, executeOpts);
        default: return { ok: false, error: { message: `unknown language: ${language}` }, durationMs: 0 };
      }
    },
    python,
    bash,
    ts,
    reset() { ts.reset(); bash.reset(); python.reset(); },
    dispose() { ts.dispose(); bash.dispose(); python.dispose(); },
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
}): {
  ts: TsInterpreter;
  python: Interpreter;
  bash: Interpreter;
  llm: LlmFn;
  dataWorld: DataWorldAccess;
  reset(): void;
  dispose(): void;
} {
  const capabilities = buildCapabilities({ llm: deps.llm, dataWorld: deps.dataWorld, bash: deps.manager.bash, python: deps.manager.python });
  const ts = new TsInterpreter({ capabilities });
  return {
    ts,
    python: deps.manager.python,
    bash: deps.manager.bash,
    llm: deps.llm,
    dataWorld: deps.dataWorld,
    reset() { ts.reset(); deps.manager.reset(); },
    dispose() { ts.dispose(); deps.manager.dispose(); },
  };
}
