import { describe, it, expect } from "vitest";
import { registerSystemTriggers, SYSTEM_ACTION } from "../../src/pth/kernel/execution/system-triggers.js";
import type { TriggerActionHandler, TriggerDef, TriggerFireContext } from "../../src/pth/kernel/execution/trigger-engine.js";

/** 捕获型 fake engine——验证注册面（不启动真实调度） */
function captureEngine() {
  const system: TriggerDef[] = [];
  const actions = new Map<string, TriggerActionHandler>();
  return {
    system,
    actions,
    engine: {
      addSystemTrigger: (def: TriggerDef) => { system.push(def); },
      registerAction: (type: string, handler: TriggerActionHandler) => { actions.set(type, handler); },
    },
  };
}

function baseDeps(over: Record<string, unknown> = {}) {
  return {
    env: {},
    recoverStaleClaims: async () => 0,
    claimTimeoutMs: 600_000,
    claimReapMs: 30_000,
    watchdogProbe: async () => 0,
    watchdogIntervalMs: 30_000,
    resolverResolve: async () => ({ processed: 0, generated: 0 }),
    resolverIntervalMs: 2_000,
    optimizerSweep: { enabled: true, intervalMs: 30_000, broadcast: () => 1 },
    log: () => {},
    ...over,
  };
}

describe("system-triggers（trigger 统一化：系统级调度指令注册中心）", () => {
  it("恒注册：origin-escalation + memory-sweep + claim/watchdog/resolver/optimizer + skill-proposal-review 七个 trigger", () => {
    const { system, engine } = captureEngine();
    registerSystemTriggers(engine as never, baseDeps());
    const names = system.map((t) => t.name).sort();
    expect(names).toEqual([
      "batch-watchdog",
      "claim-reaper",
      "flow-resolver",
      "memory-maintenance-sweep",
      "optimizer-deopt-sweep",
      "origin-escalation",
      "skill-proposal-review",
    ].sort());
    // workflow 链：origin 事件触发；memory 巡检 schedule
    expect(system.find((t) => t.name === "origin-escalation")?.event).toBe("task.rejected");
    expect(system.find((t) => t.name === "origin-escalation")?.task?.retask).toBe(true);
    expect(system.find((t) => t.name === "memory-maintenance-sweep")?.schedule?.everySec).toBe(24 * 60 * 60);
    // 控制环：schedule + 原生 action（resolver 2s；其余 30s）
    for (const name of ["claim-reaper", "batch-watchdog", "flow-resolver", "optimizer-deopt-sweep"]) {
      const t = system.find((x) => x.name === name)!;
      expect(t.action?.type).toBeTruthy();
    }
    expect(system.find((t) => t.name === "claim-reaper")?.schedule?.everySec).toBe(30);
    expect(system.find((t) => t.name === "batch-watchdog")?.schedule?.everySec).toBe(30);
    expect(system.find((t) => t.name === "flow-resolver")?.schedule?.everySec).toBe(2);
    expect(system.find((t) => t.name === "optimizer-deopt-sweep")?.schedule?.everySec).toBe(30);
  });

  it("条件注册：PTH_MEMORY_SWEEP_SECONDS=0 → 无 memory trigger；optimizer off → 无 deopt trigger；scaler 默认关 → 无 batch-scaler", () => {
    const { system, engine } = captureEngine();
    registerSystemTriggers(engine as never, baseDeps({ env: { PTH_MEMORY_SWEEP_SECONDS: "0" }, optimizerSweep: { enabled: false, intervalMs: 30_000, broadcast: () => 0 } }));
    expect(system.some((t) => t.name === "memory-maintenance-sweep")).toBe(false);
    expect(system.some((t) => t.name === "optimizer-deopt-sweep")).toBe(false);
    expect(system.some((t) => t.name === "batch-scaler")).toBe(false);
  });

  it("条件注册：scaler enabled → batch-scaler schedule + batch.scale action", () => {
    const { system, actions, engine } = captureEngine();
    registerSystemTriggers(engine as never, baseDeps({ scaler: { enabled: true, intervalMs: 30_000, evaluate: async () => ({ action: "keep" }) } }));
    expect(system.find((t) => t.name === "batch-scaler")?.action?.type).toBe(SYSTEM_ACTION.batchScale);
    expect(actions.has(SYSTEM_ACTION.batchScale)).toBe(true);
  });

  it("skill-proposal-review：事件驱动编排（L2 用户裁决 Q2）——提案落库事件 → adversarial 审核任务", () => {
    const { system, engine } = captureEngine();
    registerSystemTriggers(engine as never, baseDeps());
    const t = system.find((x) => x.name === "skill-proposal-review")!;
    expect(t.event).toBe("skill.proposal.created");
    expect(t.task?.tags).toEqual(["adversarial"]);
    // {{detail}} 事件变量（提案 id）注入任务文本——审核角色据此 query + review
    expect(t.task?.text).toContain("{{detail}}");
    expect(t.task?.text).toContain("skills.review");
    expect(t.task?.text).toContain("对抗性审核");
  });

  it("resolver action：空转 → nextMs 指数退避；有产出 → 恢复基础周期", async () => {
    const { actions, engine } = captureEngine();
    let processed = 0;
    registerSystemTriggers(engine as never, baseDeps({ resolverResolve: async () => ({ processed, generated: 0 }) }));
    const handler = actions.get(SYSTEM_ACTION.resolverResolve)!;
    const ctx = {} as TriggerFireContext;
    const r1 = await handler(ctx);
    expect(r1?.nextMs).toBe(4_000);   // 2s → 4s
    const r2 = await handler(ctx);
    expect(r2?.nextMs).toBe(8_000);   // 4s → 8s
    const r3 = await handler(ctx);
    expect(r3?.nextMs).toBe(15_000);  // 8s → 15s（上限）
    processed = 3;
    const r4 = await handler(ctx);
    expect(r4?.nextMs).toBe(2_000);   // 有产出 → 快周期
  });
});
