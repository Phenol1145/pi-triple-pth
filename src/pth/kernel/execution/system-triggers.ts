/**
 * system-triggers.ts —— 系统级 trigger 注册中心（trigger 统一化，2026-08-16）。
 *
 * 所有代码内置的调度指令在此集中注册（system trigger 不入 memory——代码即真相；
 * memory kind='trigger' 仍可经 API CRUD 增补治理链）。原生 action handler 也在此注册：
 * 确定性控制环（claim/watchdog/resolver/scaler/optimizer）走原生动作，治理任务链走 task 发布。
 *
 * 运行时一览：engine.listTriggers()（system + memory 全量）。
 */

import type { TriggerEngine } from "./trigger-engine.js";
import { buildMemorySweepTrigger } from "./memory-sweep-trigger.js";

/** 原生 action 类型名（registry 键） */
export const SYSTEM_ACTION = {
  claimReap: "claim.reap",
  watchdogProbe: "watchdog.probe",
  resolverResolve: "resolver.resolve",
  optimizerDeoptSweep: "optimizer.deopt-sweep",
  batchScale: "batch.scale",
} as const;

export interface SystemTriggerDeps {
  env?: NodeJS.ProcessEnv;
  /** claim 回收（tasks.recoverStaleClaims） */
  recoverStaleClaims?: (timeoutMs: number) => Promise<number>;
  /** claim 超时阈值（ms） */
  claimTimeoutMs: number;
  /** claim 回收周期（ms） */
  claimReapMs: number;
  /** watchdog 探测（probe 一轮） */
  watchdogProbe?: () => Promise<number>;
  /** watchdog 探测周期（ms） */
  watchdogIntervalMs: number;
  /** flow 任务解析（resolver） */
  resolverResolve?: () => Promise<{ processed: number; generated: number }>;
  /** resolver 基础周期（ms；有产出时恢复此值，空转指数退避上限 15s） */
  resolverIntervalMs: number;
  /** optimizer deopt 巡检下行（每 batch 跑一次） */
  optimizerSweep?: { enabled: boolean; intervalMs: number; broadcast: () => number };
  /** batch 自动扩缩容评估 */
  scaler?: { enabled: boolean; intervalMs: number; evaluate: () => Promise<unknown> };
  /** 日志（claim-reaper 等） */
  log?: (msg: string) => void;
}

/**
 * 注册全部系统 trigger 与原生 action handler（幂等——addSystemTrigger 按 name 去重）。
 * 调用时机：TriggerEngine.start() 之前（start 后才注册也即时生效——onScheduleTick 遍历活动数组）。
 */
export function registerSystemTriggers(engine: TriggerEngine, deps: SystemTriggerDeps): void {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((m: string) => console.log(m));

  // ── 任务链（workflow 形态：事件 trigger → 任务发布）────────────────
  // Origin 升级链（2026-08-10 任务池纯化 D3）：terminal reject → retask 转写 origin 标签。
  engine.addSystemTrigger({
    name: "origin-escalation",
    event: "task.rejected",
    task: { title: "", text: "", retask: true, tags: ["origin"] },
    enabled: true,
  });
  // 记忆维护巡检（B1/N7）：schedule trigger → memory-keeper 巡检任务（提案经监督批准）。
  const memorySweep = buildMemorySweepTrigger(env);
  if (memorySweep) engine.addSystemTrigger(memorySweep);

  // ── 控制环（loop 形态：schedule trigger → 原生 action）─────────────
  // claim 超时回收：僵尸认领回 pending（batch 崩溃/重启）。
  engine.registerAction(SYSTEM_ACTION.claimReap, async () => {
    const n = await deps.recoverStaleClaims?.(deps.claimTimeoutMs);
    if (n && n > 0) log(`[claim-reaper] recovered ${n} stale claim(s)`);
  });
  engine.addSystemTrigger({
    name: "claim-reaper",
    schedule: { everySec: deps.claimReapMs / 1000 },
    action: { type: SYSTEM_ACTION.claimReap },
    enabled: true,
  });

  // batch watchdog：崩溃记录 / 心跳陈旧挂死 kill+重启。
  engine.registerAction(SYSTEM_ACTION.watchdogProbe, async () => {
    await deps.watchdogProbe?.();
  });
  engine.addSystemTrigger({
    name: "batch-watchdog",
    schedule: { everySec: deps.watchdogIntervalMs / 1000 },
    action: { type: SYSTEM_ACTION.watchdogProbe },
    enabled: true,
  });

  // flow 解析器：有产出 → 快周期；空转 → 指数退避（2s→5s→10s→15s）。
  let resolverDelayMs = deps.resolverIntervalMs;
  engine.registerAction(SYSTEM_ACTION.resolverResolve, async () => {
    const report = (await deps.resolverResolve?.()) ?? { processed: 0, generated: 0 };
    resolverDelayMs = report.processed > 0
      ? deps.resolverIntervalMs
      : Math.min(resolverDelayMs * 2, 15_000);
    return { nextMs: resolverDelayMs };
  });
  engine.addSystemTrigger({
    name: "flow-resolver",
    schedule: { everySec: deps.resolverIntervalMs / 1000 },
    action: { type: SYSTEM_ACTION.resolverResolve },
    enabled: true,
  });

  // optimizer deopt 巡检（PTH_OPTIMIZER !== off 才注册——主进程 schedule → IPC 下行）。
  if (deps.optimizerSweep?.enabled) {
    engine.registerAction(SYSTEM_ACTION.optimizerDeoptSweep, async () => {
      deps.optimizerSweep!.broadcast();
    });
    engine.addSystemTrigger({
      name: "optimizer-deopt-sweep",
      schedule: { everySec: deps.optimizerSweep.intervalMs / 1000 },
      action: { type: SYSTEM_ACTION.optimizerDeoptSweep },
      enabled: true,
    });
  }

  // batch 自动扩缩容（PTH_BATCH_AUTOSCALE=on 才注册）。
  if (deps.scaler?.enabled) {
    engine.registerAction(SYSTEM_ACTION.batchScale, async () => {
      await deps.scaler!.evaluate();
    });
    engine.addSystemTrigger({
      name: "batch-scaler",
      schedule: { everySec: deps.scaler.intervalMs / 1000 },
      action: { type: SYSTEM_ACTION.batchScale },
      enabled: true,
    });
  }
}
