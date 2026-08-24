/**
 * bootstrap/batch/outbox-drainer.ts —— P2-9 装配段：durable side-effect outbox + drainer（F5/6.1）。
 *
 * refine observer 只 enqueue 到 outbox；drainer 轮询消费（unref timer + task-loop claim 前 kick）。
 * refineRefiners 在 createWorker 里按 roleId 注册各 worker 的 refiner，handler 按 payload.roleId 选取。
 * N29 Task 6：intake 阶段 handler 经 intakeStageHandlers 展开（mode=off 时为空——handler 集合不变）。
 */

import { PgSideEffectOutbox, createSideEffectDrainer } from "@away_from/pth-kernel-storage";
import type { SideEffectDrainerHandlers } from "@away_from/pth-kernel-storage";
import type { Refiner } from "@away_from/pth-kernel-execution";
import { pthConfig } from "@away_from/pth-config";
import { refineInputFromPayload } from "../batch-process-helpers.js";
import type { BatchLogger, BatchPool } from "./context.js";

export interface OutboxDrainerAssembly {
  sideEffectOutbox: PgSideEffectOutbox;
  /** F5：drainer handler 按 payload.roleId 选 refiner（同角色多副本时最后一个注册生效）。 */
  refineRefiners: Map<string, Pick<Refiner, "refine">>;
  /** 每轮 claim 前 kick 一次 drain（unref timer 之外的自驱动）。 */
  kickSideEffectDrainer: () => void;
}

export function assembleOutboxDrainer(input: {
  pool: BatchPool;
  batchLogger: BatchLogger;
  intakeStageHandlers: SideEffectDrainerHandlers;
}): OutboxDrainerAssembly {
  const { pool, batchLogger, intakeStageHandlers } = input;
  const sideEffectOutbox = new PgSideEffectOutbox(pool);
  const refineRefiners = new Map<string, Pick<Refiner, "refine">>();
  const sideEffectDrainer = createSideEffectDrainer({
    outbox: sideEffectOutbox,
    handlers: {
      async refine(payload) {
        const p = (payload ?? {}) as Record<string, unknown>;
        const roleId = typeof p.roleId === "string" ? p.roleId : "";
        const refiner = refineRefiners.get(roleId) ?? refineRefiners.values().next().value;
        if (!refiner) throw new Error("refiner not available for outbox refine");
        await refiner.refine(refineInputFromPayload(p));
      },
      // N29 Task 6：intake 阶段 handler（mode=off 时该展开为空——handler 集合不变）。
      ...intakeStageHandlers,
    },
    logger: (m) => batchLogger.warn(m),
    tickMs: pthConfig().num("PTH_OUTBOX_TICK_MS") || 2000,
  });
  sideEffectDrainer.start();
  const kickSideEffectDrainer = (): void => {
    void sideEffectDrainer.drainOnce().catch((e) => {
      batchLogger.warn(`side-effect drain kick failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  return { sideEffectOutbox, refineRefiners, kickSideEffectDrainer };
}
