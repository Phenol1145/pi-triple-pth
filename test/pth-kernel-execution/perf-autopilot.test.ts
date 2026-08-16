import { describe, it, expect, vi } from "vitest";
import { PerfAutopilot } from "../../src/pth/kernel/execution/perf-autopilot.js";
import { Registry, Counter, Histogram, Gauge } from "prom-client";

/** 构造带指标的 registry（L1/L2/LLM——模拟 batch IPC 计量后的形态） */
function makeRegistry(opts: { rejectRate?: number; execFailRate?: number; llmAvgMs?: number; pending?: number }) {
  const reg = new Registry();
  const status = new Counter({ name: "pth_task_status_total", help: "task status", labelNames: ["status"], registers: [reg] });
  const exec = new Counter({ name: "pth_kernel_exec_total", help: "kernel exec", labelNames: ["language", "ok"], registers: [reg] });
  const llm = new Histogram({ name: "pth_llm_latency_seconds", help: "llm latency", labelNames: ["provider", "model"], registers: [reg] });
  const pending = new Gauge({ name: "pth_task_pending", help: "pending tasks", registers: [reg] });
  pending.set(opts.pending ?? 0);
  // 填充窗口增量
  const total = 20;
  const rej = Math.round(total * (opts.rejectRate ?? 0));
  status.inc({ status: "completed" }, total - rej);
  status.inc({ status: "rejected" }, rej);
  const exFail = Math.round(total * (opts.execFailRate ?? 0));
  exec.inc({ language: "ts", ok: "true" }, total - exFail);
  exec.inc({ language: "ts", ok: "false" }, exFail);
  if (opts.llmAvgMs) {
    for (let i = 0; i < 5; i++) llm.observe({ provider: "deepseek", model: "flash" }, opts.llmAvgMs / 1000);
  }
  return reg;
}

function makeAutopilot(reg: Registry, over: Record<string, unknown> = {}) {
  const params = new Map<string, string>();
  return {
    ap: new PerfAutopilot({
      registry: reg,
      setParam: (k, v) => params.set(k, String(v)),
      getParam: (k) => params.get(k) ?? process.env[k],
      countPendingByRole: async () => ({ developer: 10, analyst: 2 }),
      spawnReinforced: async () => undefined,
      log: () => {},
    }, { mode: "on", intervalMs: 100, windowMs: 1000, ...over } as never),
    params,
  };
}

describe("PerfAutopilot（v0.8 系统自持——性能自愈闭环）", () => {
  it("R4：reject 率高 → 记录诊断（不自动改参）", async () => {
    const reg = makeRegistry({ rejectRate: 0.5 });
    const { ap } = makeAutopilot(reg);
    await ap.tick();
    const last = ap.status.lastAction!;
    expect(last.rule).toBe("R4");
    expect(last.action).toBe("record");
  });

  it("R2：LLM 慢 → 超时调参（可回滚）", async () => {
    const reg = makeRegistry({ llmAvgMs: 45_000 });
    const { ap, params } = makeAutopilot(reg, { llmSlowMs: 30_000 });
    params.set("PTH_AGENT_LLM_TIMEOUT_MS", "60000");
    await ap.tick();
    const last = ap.status.lastAction!;
    expect(last.rule).toBe("R2");
    expect(last.action).toBe("setParam");
    expect(params.get("PTH_AGENT_LLM_TIMEOUT_MS")).toBe("45000");  // 60000 - 15000
  });

  it("R2 回滚：调参后 reject 率恶化 → tick 内自动恢复原值（trigger 统一化接线修复）", async () => {
    const reg = makeRegistry({ rejectRate: 0.5, llmAvgMs: 40_000 });
    const { ap, params } = makeAutopilot(reg, { llmSlowMs: 30_000, rejectRate: 0.3 });
    params.set("PTH_AGENT_LLM_TIMEOUT_MS", "60000");
    await ap.tick();          // R2 调参 → 同窗口内 reject 率恶化 → 自动回滚
    expect(params.get("PTH_AGENT_LLM_TIMEOUT_MS")).toBe("60000");
    const last = ap.status.lastAction!;
    expect(last.action).toBe("rollback");
  });

  it("R1：pending 增长 → 扩缩（防抖窗口内不重复）", async () => {
    const reg2 = makeRegistry({ pending: 15 });  // 增长 1.5x > 1.3（对比 lastPending=10）
    const spawned: string[] = [];
    const params = new Map<string, string>();
    const ap = new PerfAutopilot({
      registry: reg2, setParam: (k, v) => params.set(k, String(v)), getParam: (k) => params.get(k),
      countPendingByRole: async () => ({ developer: 10, analyst: 2 }),
      spawnReinforced: async (role, copies) => { spawned.push(`${role}+${copies}`); },
      log: () => {},
    }, { mode: "on", pendingGrowth: 1.3, windowMs: 1000 } as never);
    // 模拟上一窗口基线 pending=10（当前 registry 15 → 增长 1.5x > 1.3）
    (ap as unknown as { lastPending: number | null }).lastPending = 10;
    await ap.tick();
    expect(spawned.length).toBeGreaterThan(0);  // R1 扩缩触发
  });

  it("R3：exec 失败率高 → 记录（不自动改参）", async () => {
    const reg = makeRegistry({ execFailRate: 0.5 });
    const { ap } = makeAutopilot(reg);
    await ap.tick();
    expect(ap.status.lastAction!.rule).toBe("R3");
  });

  it("off 模式：start 不启动循环", () => {
    const reg = makeRegistry({});
    const { ap } = makeAutopilot(reg, { mode: "off" });
    ap.start();
    expect(ap.status.mode).toBe("off");
  });

  it("指标缺失容错（registry 空——不崩）", async () => {
    const reg = new Registry();
    const { ap } = makeAutopilot(reg);
    await ap.tick();  // 不抛
    expect(ap.status.lastAction).toBeNull();
  });
});
