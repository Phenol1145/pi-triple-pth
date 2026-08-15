/**
 * interpreter/index.ts —— 核抽象层（核心机制）
 *
 * 2026-08-12 用户裁决分层：本文件只保留 WorkerKernel 接口（核心协议面）；
 * 具体核实现与装配工厂在 impls/kernels/（createWorkerKernel/createKernelManager
 * 等由 impls/kernels/index.js 提供——消费者从实现层 import）。
 */
// WorkerKernel/WorkerKernelDeps 移入 pth-sandbox 包（2026-08-15 拆分——内核契约包含在沙箱包内）
export type * from "@away_from/pth-sandbox";
export type { WorkerKernel, WorkerKernelDeps } from "@away_from/pth-sandbox";
export * from "./llm-fn.js";
export * from "./toolstore.js";
export * from "./read-source.js";
export * from "./kernel-config.js";
export * from "./ext-capability.js";
