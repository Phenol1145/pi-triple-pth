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
  penetrationDiscovery: "penetration.discovery",
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
  /** 穿透稳定边自动发现巡检（B1） */
  penetrationDiscovery?: { enabled: boolean; intervalMs: number; discover: () => Promise<unknown> };
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

  // skill 维护提案对抗性审核派发（L2——2026-08-18 用户裁决 Q2 事件驱动编排）：
  // memory-keeper skills.maintain.propose 落库即发 skill.proposal.created 事件（detail=提案 id）
  // → 本 trigger 自动派发 controller:adversarial 审核任务（W5 staged 流：提案→审核→批准→执行）。
  // {{detail}} = 提案 id（事件变量注入任务文本——审核角色据此 memory.query 提案并 skills.review）。
  engine.addSystemTrigger({
    name: "skill-proposal-review",
    event: "skill.proposal.created",
    task: {
      title: "skill 维护提案对抗性审核",
      text: [
        "对 skill 维护提案做对抗性审核（reward-hacking 显式检验）。",
        "提案 id：{{detail}}",
        "步骤：① memory.query 读取提案（SELECT * FROM memory_entries WHERE id = '{{detail}}'——kind=skill-maintain-proposal，content 为提案 JSON）；",
        "② 检验三问：Pitfalls 完整性（是否覆盖已知失败模式）/ Verification 可测性（是否可证伪）/ 作弊捷径（绕过治理、越权、目标函数漏洞）；",
        "③ 裁决：skills.review('{{detail}}', 'pass', '<理由>') 或 skills.review('{{detail}}', 'reject', '<缺口清单>')；",
        "只读审核——不执行维护（批准与执行走监督通道）。",
      ].join("\n"),
      tags: ["adversarial"],
    },
    enabled: true,
  });

  // 工具注册提案对抗性审核派发（N14 P3——skill-proposal-review 同构）：
  // controller:tool-face manage.tool.register（staged 策略）落库即发 tool.proposal.created
  // → 本 trigger 自动派发 controller:adversarial 审核任务（§3.4 治理流：提案→审核→批准→注册）。
  // {{detail}} = 提案 id——审核角色 tools.review 裁决（schema 质量 / 执行体安全 / 作弊捷径）。
  engine.addSystemTrigger({
    name: "tool-proposal-review",
    event: "tool.proposal.created",
    task: {
      title: "工具注册提案对抗性审核",
      text: [
        "对工具注册提案做对抗性审核（N14 §3.4 治理流——与 skill 审核同构）。",
        "提案 id：{{detail}}",
        "步骤：① memory.query 读取提案（SELECT * FROM memory_entries WHERE id = '{{detail}}'——kind=tool-proposal，content 为提案 JSON）；",
        "② 检验三问：schema 质量（参数契约与执行体输入一致）/ 执行体安全（program 态无越权副作用、agent 态角色与产物契约合法）/ 作弊捷径（绕过治理、预算守卫规避、目标函数漏洞）；",
        "③ 裁决：tools.review('{{detail}}', 'pass', '<理由>') 或 tools.review('{{detail}}', 'reject', '<缺口清单>')；",
        "只读审核——不执行注册（批准与执行走监督通道）。",
      ].join("\n"),
      tags: ["adversarial"],
    },
    enabled: true,
  });

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

  // 穿透稳定边自动发现巡检（N15 B1——enabled 时注册 schedule + 原生 action）。
  if (deps.penetrationDiscovery?.enabled) {
    engine.registerAction(SYSTEM_ACTION.penetrationDiscovery, async () => {
      const result = (await deps.penetrationDiscovery!.discover()) as { created?: unknown };
      return { created: result?.created } as unknown as { nextMs?: number };
    });
    engine.addSystemTrigger({
      name: "penetration-discovery",
      schedule: { everySec: deps.penetrationDiscovery.intervalMs / 1000 },
      action: { type: SYSTEM_ACTION.penetrationDiscovery },
      enabled: true,
    });
  }
}
