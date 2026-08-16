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
import type { InterpreterSnapshot } from "@away_from/pth-sandbox";
import { TsInterpreter } from "./ts-interpreter.js";
import { BashInterpreter } from "@away_from/pth-sandbox";
import { PythonInterpreter } from "./python-interpreter.js";
import { createLlmFn, type LlmFn } from "../../kernel/interpreter/llm-fn.js";
import { buildCapabilities } from "./capability.js";
import type { Interpreter, InterpreterResult, WorkerKernel, WorkerKernelDeps } from "../../kernel/interpreter/index.js";
import { setKernelExecFactory } from "../../kernel/execution/kernel-factories.js";

// 模块化 v2 P0-5：pth-sandbox 的契约类型与网关用沙箱客户端符号统一经本 re-export 点
// 进入 PTH 业务代码（守护拆分裁决：内核契约留在 pth-sandbox，业务代码不散落直接 import 包）。
export type { SandboxBashDefinition, SandboxHealthMonitor } from "@away_from/pth-sandbox";
export { SandboxExecClient, SandboxForwardError } from "@away_from/pth-sandbox";

/** 一个 worker = 三解释器 + llm 函数 + 数据世界连接（Spec B 消费——2026-08-12 分层移入实现层） */
export function createWorkerKernel(deps: WorkerKernelDeps<DataWorldAccess>): WorkerKernel {
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
    // 程序级制动（2026-08-14 A1 Phase 3 条目 11）：abort 三核 in-flight（Bash/PythonInterpreter
    // 无 in-flight 概念——abort 缺省 undefined，仅 ts 核有实现）
    abort: async () => {
      await ts.abort();
    },
  };
}

// 2026-08-13 审计 P1 瘦身：barrel 消费面仅 batch-process 的 3 个符号——其余重导出删除
// （ts-prune 实测 25 个死重导出；消费者直连子文件——ts-interpreter/kernel-manager 等）
import { createWorkerKernelWithManager, createKernelManager } from "./kernel-manager.js";
export { createWorkerKernelWithManager, createKernelManager };

// 模块化优化 P0：具体核实现注册到 kernel 工厂端口（装配层 import 本文件即注入）。
setKernelExecFactory({ createKernelManager, createWorkerKernelWithManager });
