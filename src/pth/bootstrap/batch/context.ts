/**
 * bootstrap/batch/context.ts —— batch 组合根各装配段共享的结构类型（P2-9 拆分）。
 *
 * 仅承载跨段传递的类型与轻量状态形状，不含装配逻辑；
 * 各 section-assembler 通过这里的类型显式声明输入/输出，batch-process 只做编排。
 */

import type { createPgPool, createDataWorld } from "@away_from/pth-kernel-storage";
import type { KernelLogger, WorkerRole, WorkerReplica } from "@away_from/pth-kernel-execution";
import type { BatchTaskLoop } from "../batch-process-helpers.js";

/** PG 连接池（createPgPool 产物）。 */
export type BatchPool = Awaited<ReturnType<typeof createPgPool>>;

/** createDataWorld 装配产物（P0-4：legacy assembly-only 装配点）。 */
export type BatchDataWorld = ReturnType<typeof createDataWorld>;

export type BatchLogger = KernelLogger;

/** legacy（off）模式 worker 注册表条目（worker 级控制面 IPC 寻址用 role）。 */
export type BatchLoopEntry = BatchTaskLoop & { role: WorkerRole };

/**
 * createWorker 装配产物（跨段共享的结构形状）。
 * ipc-control / feasibility-runtime 只消费可选生命周期方法与身份字段，不依赖具体 kernel 类型。
 */
export interface CreatedWorker {
  loop: BatchTaskLoop;
  kernel: {
    abort?: () => Promise<void> | void;
    dispose?: () => Promise<void> | void;
  };
  optimizer: { stop?: () => void; sweep?: () => Promise<void> } | undefined;
  replica: WorkerReplica | undefined;
  role: WorkerRole;
}

/**
 * N29 Task 6：due scanner 的 IPC trigger 句柄。装配在 drainer 之后完成后写入；
 * `PTH_KNOWLEDGE_INTAKE_MODE=off` 时永远为 undefined —— trigger 收到消息也只回 ran:false。
 * 提前声明是为了让 `process.on("message")`（注册于装配之前）安全闭包引用，避免 TDZ。
 */
export interface IntakeTrigger {
  run?: () => Promise<number>;
}

/** 暂停/恢复控制状态（IPC pause/resume 写，tick 读）。 */
export interface BatchControlState {
  paused: boolean;
}

/**
 * N33 复验收 P1-2：feasibility worker 最近一次认知工作集账本快照（心跳时有界投影）。
 * 由 feasibility-runtime 的 provider 写入，ipc-control 的 status reporter 读取。
 */
export type AuthoritativeWorkingSets = Map<string, {
  taskId: string;
  directorySnapshotId: string;
  snapshot: ReturnType<import("@away_from/pth-kernel-execution").CognitiveBudgetLedger["snapshot"]>;
}>;
