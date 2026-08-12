/**
 * impls/kernels/index.ts —— 内置核装配（具体实现层）
 *
 * 2026-08-12 用户裁决：PTH 核心机制与具体实现分层——具体核（ts/python/bash/C +
 * sandbox 实现）与 worker 核装配（createWorkerKernel/createKernelManager）是"实现"，
 * 由核心的 execution（agent-loop/batch-process）消费。
 *
 * 分层：核心 = interpreter/（WorkerKernel 接口/types/llm-fn/toolstore/exec-channel）；
 *       实现 = 本目录（12 核实现文件 + 本装配入口）。
 */
import type { ModelRouter } from "@away_from/infra";
import type { DataWorldAccess } from "../../kernel/storage/index.js";
import type { InterpreterSnapshot } from "../../kernel/interpreter/types.js";
import { TsInterpreter } from "./ts-interpreter.js";
import { BashInterpreter } from "./bash-interpreter.js";
import { PythonInterpreter } from "./python-interpreter.js";
import { createLlmFn, type LlmFn } from "../../kernel/interpreter/llm-fn.js";
import { buildCapabilities } from "./capability.js";
import type { Interpreter, InterpreterResult, WorkerKernel, WorkerKernelDeps } from "../../kernel/interpreter/index.js";

/** 一个 worker = 三解释器 + llm 函数 + 数据世界连接（Spec B 消费——2026-08-12 分层移入实现层） */
export function createWorkerKernel(deps: WorkerKernelDeps): WorkerKernel {
  const llm = createLlmFn({ modelRouter: deps.modelRouter });
  const bash = new BashInterpreter({ sandbox: deps.sandbox ?? { exec: async () => ({ ok: false, stdout: "", stderr: "sandbox not configured", exitCode: 1, durationMs: 0 }) } });
  const python = new PythonInterpreter({ pythonBin: deps.pythonBin });
  const capabilities = buildCapabilities({ llm, dataWorld: deps.dataWorld, bash, python });
  const ts = new TsInterpreter({ capabilities });
  return {
    ts, bash, python, llm, dataWorld: deps.dataWorld,
    snapshot: async () => {
      const tsSnap = await ts.snapshot();
      const pySnap = await python.snapshot();
      const bSnap = await bash.snapshot();
      return {
        variables: [...tsSnap.variables, ...pySnap.variables],
        functions: [...tsSnap.functions, ...pySnap.functions],
        oversized: [...tsSnap.oversized, ...pySnap.oversized, ...bSnap.oversized],
      };
    },
    reset() { ts.reset(); bash.reset(); python.reset(); },
    dispose() { ts.dispose(); bash.dispose(); python.dispose(); },
  };
}

export { createWorkerKernelWithManager, createKernelManager, type KernelManager, type KernelManagerOptions } from "./kernel-manager.js";
export { TsInterpreter } from "./ts-interpreter.js";
export * from "./bash-interpreter.js";
// 适配说明：python-interpreter 与 ts-interpreter 均导出 DEFAULT_EXECUTION_TIMEOUT_MS，
// 双 star re-export 触发 TS2308（歧义成员）。显式只 re-export PythonInterpreter 类。
export { PythonInterpreter } from "./python-interpreter.js";
export * from "./capability.js";
export * from "./py-kernel.js";
export * from "./bash-kernel.js";
export * from "./compiled-kernel.js";
export * from "./sandbox-kernel.js";
export * from "./sandbox-compiled-kernel.js";
export * from "./sandbox-debug-session.js";
export * from "./gdb-mi.js";
export * from "./pth-memory-lib.js";
