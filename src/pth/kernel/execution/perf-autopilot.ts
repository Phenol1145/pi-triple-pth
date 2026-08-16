/**
 * perf-autopilot.ts — PTH 系统自持（v0.8）：性能自愈闭环
 *
 * 监视（prom-client 指标窗口）→ 诊断（规则表）→ 自动调节（perf.set / 扩缩）→
 * 复测验证（下窗口对比——改善保持 / 恶化回滚原值）。无需人工/agent 介入。
 *
 * 保守原则：可回滚动作（调参）才自动执行；结构性诊断（R3/R4）只记录。
 * 防抖：同规则窗口内不重复动作（冷却）+ 回滚后同窗口不重复调节。
 *
 * 设计：docs/superpowers/specs/2026-08-09-pth-autopilot-design.md
 */

import type { Registry } from "prom-client";

export interface AutopilotDeps {
  /** prom-client registry（与 /metrics 同源——L1/L2/L3 指标） */
  registry: Registry;
  /** 参数调节（perf.set 同源——运行时 PTH_* 参数） */
  setParam: (key: string, value: string | number) => void;
  /** 参数读取（回滚用） */
  getParam: (key: string) => string | undefined;
  /** 扩缩（descheduler——R1 积压缓解） */
  countPendingByRole?: () => Promise<Record<string, number>>;
  spawnReinforced?: (role: string, copies: number) => Promise<unknown>;
  /** 日志 */
  log?: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
}

export interface AutopilotOptions {
  mode?: "on" | "off";
  intervalMs?: number;
  windowMs?: number;
  rejectRate?: number;      // R4
  execFailRate?: number;    // R3
  llmSlowMs?: number;       // R2
  pendingGrowth?: number;   // R1
  maxCopies?: number;       // R1 单轮上限
}

export interface AutopilotAction {
  rule: string;
  action: string;
  detail: string;
  ts: number;
  rolledBack?: boolean;
}

export interface AutopilotStatus {
  mode: "on" | "off";
  lastCheckAt: number | null;
  lastAction: AutopilotAction | null;
  actions: AutopilotAction[];
  window: { rejectRate: number; execFailRate: number; llmAvgMs: number; pendingGrowth: number };
}

interface MetricWindow {
  rejectRate: number;    // L2 taskStatus rejected 占比
  execFailRate: number;  // L1 kernel exec ok=false 占比
  llmAvgMs: number;      // LLM 直方图均值
  pending: number;       // L2 taskPending 当前值
  pendingPrev: number;   // 上一窗口
  pendingGrowth: number; // pending 增长比（当前/上轮）
}

/** 指标 JSON 类型（getMetricsAsJSON 聚合形态——prom-client v15 的 get() 返回空，需用 JSON） */
interface MetricJSON {
  name: string;
  values: Array<{ labels?: Record<string, string>; value: number }>;
}

function readCounterDelta(prev: number | null, cur: number | null): number {
  if (cur === null) return 0;
  if (prev === null) return cur;
  return Math.max(0, cur - prev);
}

export class PerfAutopilot {
  private deps: AutopilotDeps;
  private opts: AutopilotOptions;
  private timer: NodeJS.Timeout | null = null;
  private lastCheckAt: number | null = null;
  private actions: AutopilotAction[] = [];
  /** 防抖：rule → 最近动作 ts（冷却窗口内不重复） */
  private cooldown = new Map<string, number>();
  /** 回滚基线：rule → {key, value}（回滚恢复原值） */
  private rollback = new Map<string, { key: string; value: string | undefined }>();
  /** 窗口计数基线（counter 增量） */
  private prev = { statusRejected: null as number | null, statusTotal: null as number | null, execFail: null as number | null, execTotal: null as number | null, llmCalls: null as number | null, llmMs: null as number | null };
  private lastPending: number | null = null;

  constructor(deps: AutopilotDeps, opts: AutopilotOptions = {}) {
    this.deps = deps;
    this.opts = opts;
  }

  get status(): AutopilotStatus {
    return {
      mode: this.opts.mode === "on" ? "on" : "off",
      lastCheckAt: this.lastCheckAt,
      lastAction: this.actions[this.actions.length - 1] ?? null,
      actions: this.actions.slice(-10),
      window: this.currentWindow(),
    };
  }

  private log(level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
    this.deps.log?.(level, msg, meta);
  }

  /** 启动自治循环（unref——不阻止退出） */
  start(): void {
    if (this.opts.mode !== "on" || this.timer) return;
    const interval = this.opts.intervalMs ?? 30_000;
    this.timer = setInterval(() => { void this.tick().catch((e) => this.log("error", `autopilot tick failed: ${(e as Error).message}`)); }, interval);
    this.timer.unref?.();
    this.log("info", "autopilot 启动（自愈闭环）", { intervalMs: interval });
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private currentWindow(): MetricWindow {
    return {
      rejectRate: this.lastWindow?.rejectRate ?? 0,
      execFailRate: this.lastWindow?.execFailRate ?? 0,
      llmAvgMs: this.lastWindow?.llmAvgMs ?? 0,
      pending: this.lastWindow?.pending ?? 0,
      pendingPrev: this.lastWindow?.pendingPrev ?? 0,
      pendingGrowth: this.lastWindow?.pendingGrowth ?? 0,
    };
  }
  private lastWindow: MetricWindow | null = null;

  /** 一轮：采样窗口 → 规则诊断 → 动作执行（复测在下一轮窗口对比） */
  async tick(): Promise<void> {
    this.lastCheckAt = Date.now();
    let metrics: MetricJSON[] = [];
    try {
      metrics = (await this.deps.registry.getMetricsAsJSON()) as unknown as MetricJSON[];
    } catch { /* registry 不可读——窗口全零（容错） */ }
    const w = this.sampleWindow(metrics);
    this.lastWindow = w;

    // R1：pending 增长 → 积压角色扩缩
    if (this.deps.countPendingByRole && this.deps.spawnReinforced) {
      await this.ruleR1(w);
    }
    // R2：LLM 慢 → 超时调参（可回滚）
    this.ruleR2(w);
    // R3/R4：结构性诊断——只记录
    if (w.execFailRate > (this.opts.execFailRate ?? 0.2)) {
      this.record({ rule: "R3", action: "record", detail: `kernel exec 失败率 ${(w.execFailRate * 100).toFixed(1)}% > 阈值——sandbox/编译问题（记录不自动改参）` });
    }
    if (w.rejectRate > (this.opts.rejectRate ?? 0.3)) {
      this.record({ rule: "R4", action: "record", detail: `任务 reject 率 ${(w.rejectRate * 100).toFixed(1)}% > 阈值——执行失败集中（记录不自动改参）` });
    }
    // trigger 统一化接线修复（2026-08-16）：回滚复测原本只有测试手动调用、生产从未执行——
    // 现在每轮 tick 末尾闭环（R2 调参后 reject 率恶化 → 恢复原值）。
    this.checkRollback();
  }

  /** 指标窗口采样（L1/L2/LLM——缺失容错） */
  private sampleWindow(metrics: MetricJSON[]): MetricWindow {
    const sum = (name: string, labelName?: string, labelValue?: string, metricName?: string): number =>
      metrics
        .filter((m) => m.name === name)
        .flatMap((m) => m.values)
        .filter((v) => !metricName || (v as { metricName?: string }).metricName === metricName)
        .filter((v) => !labelName || v.labels?.[labelName] === labelValue)
        .reduce((a, v) => a + (v.value ?? 0), 0);

    // L2 taskStatus：rejected / total（counter 增量）
    const rejectedCur = sum("pth_task_status_total", "status", "rejected");
    const totalCur = sum("pth_task_status_total");
    const rejectedDelta = readCounterDelta(this.prev.statusRejected, rejectedCur);
    const totalDelta = readCounterDelta(this.prev.statusTotal, totalCur);
    this.prev.statusRejected = rejectedCur;
    this.prev.statusTotal = totalCur;
    const rejectRate = totalDelta > 0 ? rejectedDelta / totalDelta : 0;

    // L1 kernel exec 失败率（pth_kernel_exec_total——ok 标签）
    const execFailCur = sum("pth_kernel_exec_total", "ok", "false");
    const execTotalCur = sum("pth_kernel_exec_total");
    const execFailDelta = readCounterDelta(this.prev.execFail, execFailCur);
    const execTotalDelta = readCounterDelta(this.prev.execTotal, execTotalCur);
    this.prev.execFail = execFailCur;
    this.prev.execTotal = execTotalCur;
    const execFailRate = execTotalDelta > 0 ? execFailDelta / execTotalDelta : 0;

    // LLM 延迟均值（pth_llm_latency_seconds 直方图——sum/count 增量）
    const llmSum = sum("pth_llm_latency_seconds", undefined, undefined, "pth_llm_latency_seconds_sum");
    const llmCount = sum("pth_llm_latency_seconds", undefined, undefined, "pth_llm_latency_seconds_count");
    const llmSumDelta = readCounterDelta(this.prev.llmMs, llmSum);
    const llmCountDelta = readCounterDelta(this.prev.llmCalls, llmCount);
    this.prev.llmMs = llmSum;
    this.prev.llmCalls = llmCount;
    const llmAvgMs = llmCountDelta > 0 ? (llmSumDelta / llmCountDelta) * 1000 : 0;

    // pending 增长（当前 vs 上轮）
    const pending = sum("pth_task_pending");
    const pendingPrev = this.lastPending;
    this.lastPending = pending;
    const pendingGrowth = pendingPrev !== null && pendingPrev > 0 ? pending / pendingPrev : 0;

    return { rejectRate, execFailRate, llmAvgMs, pending, pendingPrev: pendingPrev ?? 0, pendingGrowth };
  }


  /** R1：pending 持续增长 → 积压角色扩缩（防抖 + 上限） */
  private async ruleR1(w: MetricWindow): Promise<void> {
    const growth = w.pendingGrowth;
    const threshold = this.opts.pendingGrowth ?? 1.3;
    if (growth <= threshold || w.pending < 3) return;  // 无显著增长或量小
    if (this.cooldown.get("R1") && Date.now() - (this.cooldown.get("R1") ?? 0) < (this.opts.windowMs ?? 60_000)) return;
    try {
      const byRole = await this.deps.countPendingByRole!();
      const top = Object.entries(byRole).sort((a, b) => b[1] - a[1])[0];
      if (!top || top[1] < 1) return;
      const copies = Math.min(Math.max(Math.ceil(top[1] / 5), 1), this.opts.maxCopies ?? 4);
      await this.deps.spawnReinforced!(top[0], copies);
      this.cooldown.set("R1", Date.now());
      this.record({ rule: "R1", action: "spawnReinforced", detail: `pending 增长 ${growth.toFixed(2)}x（top 角色 ${top[0]}=${top[1]}）→ 强化 +${copies}` });
      this.log("info", `autopilot R1 扩缩 ${top[0]} +${copies}`, { pending: w.pending, growth });
    } catch (e) {
      this.log("warn", `autopilot R1 失败: ${(e as Error).message}`);
    }
  }

  /** R2：LLM 慢 → 超时调参（可回滚——复测恶化恢复原值） */
  private ruleR2(w: MetricWindow): void {
    const slowMs = this.opts.llmSlowMs ?? 30_000;
    if (w.llmAvgMs <= slowMs) return;
    if (this.cooldown.get("R2") && Date.now() - (this.cooldown.get("R2") ?? 0) < (this.opts.windowMs ?? 60_000)) return;
    const key = "PTH_AGENT_LLM_TIMEOUT_MS";
    const cur = this.deps.getParam(key) ?? "60000";
    const target = Math.max(Number(cur) - 15_000, 10_000);
    if (target >= Number(cur)) return;  // 已到下限
    this.deps.setParam(key, target);
    this.rollback.set("R2", { key, value: cur });
    this.cooldown.set("R2", Date.now());
    this.record({ rule: "R2", action: "setParam", detail: `LLM 均值 ${(w.llmAvgMs / 1000).toFixed(1)}s > ${(slowMs / 1000).toFixed(0)}s → ${key} ${cur}→${target}` });
    this.log("warn", `autopilot R2 调参 ${key}=${target}`, { llmAvgMs: w.llmAvgMs, prev: cur });
  }

  /** 复测：窗口恶化 → 回滚（R2 调参——R1 扩缩幂等不回滚） */
  checkRollback(): void {
    if (!this.lastWindow) return;
    const r2 = this.rollback.get("R2");
    if (!r2) return;
    // 若 LLM 仍慢且当前值已调——保持（调参已生效窗口内）；恶化指超时过短导致任务失败——
    // v1 简化：超时调参后若 reject 率上升 → 回滚
    if (this.lastWindow.rejectRate > (this.opts.rejectRate ?? 0.3)) {
      this.deps.setParam(r2.key, r2.value ?? "60000");
      this.rollback.delete("R2");
      this.record({ rule: "R2", action: "rollback", detail: `reject 率上升 → 恢复 ${r2.key}=${r2.value}` });
      this.log("warn", `autopilot R2 回滚 ${r2.key}=${r2.value}`);
    }
  }

  private record(a: Omit<AutopilotAction, "ts">): void {
    const full: AutopilotAction = { ...a, ts: Date.now() };
    this.actions.push(full);
    if (this.actions.length > 100) this.actions.shift();
  }
}
