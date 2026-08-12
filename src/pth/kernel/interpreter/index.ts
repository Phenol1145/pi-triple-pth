/**
 * interpreter/index.ts —— 核抽象层（核心机制）
 *
 * 2026-08-12 用户裁决分层：本文件只保留 WorkerKernel 接口（核心协议面）；
 * 具体核实现与装配工厂在 impls/kernels/（createWorkerKernel/createKernelManager
 * 等由 impls/kernels/index.js 提供——消费者从实现层 import）。
 */
import type { ModelRouter } from "@away_from/infra";
import type { DataWorldAccess } from "../storage/index.js";
import type { InterpreterSnapshot } from "./types.js";
import type { LlmFn } from "./llm-fn.js";
import type { Interpreter, InterpreterResult } from "./types.js";

export interface WorkerKernel {
  ts: Interpreter;
  bash: Interpreter;
  python: Interpreter;
  /** C 编译核（可选——createWorkerKernelWithManager + sandboxKernel 配置时存在；生产核 dev.build/dev.run 用） */
  c?: Interpreter;
  /** 顶层语言路由（2026-08-12 asm-kernel 接线）：extra kernels（ext.kernel 注册）经此执行——
   *  可选（普通版 createWorkerKernel 无 extra kernels——不提供） */
  execute?(language: string, program: string, opts?: import("./types.js").ExecuteOptions): Promise<InterpreterResult>;
  llm: LlmFn;
  dataWorld: DataWorldAccess;
  /** 聚合快照（T4 refine 输入）：ts + python + bash 三 kernel 状态 */
  snapshot(): InterpreterSnapshot | Promise<InterpreterSnapshot>;
  reset(): void;
  dispose(): void;
}

export interface WorkerKernelDeps {
  modelRouter: ModelRouter;
  dataWorld: DataWorldAccess;
  sandbox?: { exec(req: any, signal?: AbortSignal): Promise<any> };
  pythonBin?: string;
}

export * from "./types.js";
export * from "./llm-fn.js";
export * from "./toolstore.js";
export * from "./read-source.js";
export * from "./kernel-config.js";
export * from "./ext-capability.js";
