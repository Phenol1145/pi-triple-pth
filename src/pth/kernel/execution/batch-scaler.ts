/**
 * batch-scaler —— 自动化扩缩容（BatchSuggestion Task 7 落地）。
 *
 * 信号（正交化后语义清晰）：pendingCount = 各角色队列和（countPending 全局统计）
 *   - pending > 阈值 且 batch < max          → scale-up（扩容 1）
 *   - batch > min 且 pending == 0 且全 idle   → scale-down（缩容 1，保守：一次 1 个）
 *   - 其余 keep
 *
 * 参数化（仿 PG，env 可调）：
 *   PTH_BATCH_AUTOSCALE           on/off（默认 off——2026-08-09 单大 batch 化：worker 级控制为主，
 *                                batch 级扩缩降级为特殊手段（故障隔离/多租户），显式开启）
 *   PTH_BATCH_MIN                 默认 1（下限保护）
 *   PTH_BATCH_MAX                 默认 4（上限保护）
 *   PTH_BATCH_SCALE_INTERVAL_MS   默认 30000（评估周期）
 *   PTH_BATCH_SCALE_UP_THRESHOLD  默认 5（pending 积压阈值）
 */
import type { BatchSuggestion } from "./stats.js";

export interface ScaleInput {
  pendingCount: number;
  /** 全部 batch 的平均空闲率（1=全空闲） */
  idleRatio: number;
  batchCount: number;
  min: number;
  max: number;
  upThreshold: number;
}

export interface ScaleDecision {
  action: "scale-up" | "scale-down" | "keep";
  reason: string;
}

/** 决策纯函数（可测试）：返回建议动作 */
export function decideScale(input: ScaleInput): ScaleDecision {
  const { pendingCount, idleRatio, batchCount, min, max, upThreshold } = input;
  // 上限保护
  if (batchCount >= max && pendingCount > upThreshold) {
    return { action: "keep", reason: `batch 已达上限 ${max}（pending=${pendingCount}）` };
  }
  // 扩容：积压超阈值
  if (pendingCount > upThreshold && batchCount < max) {
    return { action: "scale-up", reason: `pending=${pendingCount} > 阈值 ${upThreshold}（batch=${batchCount}/${max}）` };
  }
  // 下限保护 + 防误杀（有任务在跑不缩）
  if (batchCount <= min) {
    return { action: "keep", reason: `batch 已达下限 ${min}` };
  }
  if (pendingCount === 0 && idleRatio >= 1) {
    return { action: "scale-down", reason: `全部空闲（idleRatio=${idleRatio}）且无积压（batch=${batchCount} > min=${min}）` };
  }
  return { action: "keep", reason: `pending=${pendingCount} idle=${idleRatio}（未触发）` };
}

export interface BatchScalerDeps {
  countPending: () => Promise<number>;
  batchCount: () => Promise<number>;
  avgIdleRatio: () => Promise<number>;
  spawnBatch: () => Promise<unknown>;
  killOneIdle: () => Promise<boolean>;
  /** per-role 队列深度（reinforced 模式——自动强化调度） */
  countPendingByRole?: () => Promise<Record<string, number>>;
  /** 按角色强化扩（reinforced——自动调度用；缺省 scale-up 退化为整 batch） */
  spawnReinforced?: (role: string, copies: number) => Promise<unknown>;
  logger?: (msg: string) => void;
  onScale?: (d: ScaleDecision) => void;
}

/** 自动扩缩容执行器：评估一次并执行动作（幂等——每周期最多 1 个动作） */
export interface AutoScaleConfig extends Omit<ScaleInput, "pendingCount" | "idleRatio" | "batchCount"> {
  /** 模式：off（不扩）| balanced（整 batch）| reinforced（per-role 强化——descheduler） */
  mode?: "off" | "balanced" | "reinforced";
  /** reinforced：单角色积压阈值（默认 5） */
  roleThreshold?: number;
  /** reinforced：强化副本数（默认 2） */
  reinforceCopies?: number;
}

export async function evaluateAndScale(deps: BatchScalerDeps, cfg: AutoScaleConfig): Promise<ScaleDecision> {
  const mode = cfg.mode ?? "balanced";
  if (mode === "off") return { action: "keep", reason: "autoscale off" };

  // reinforced 模式：per-role 积压 → 强化 batch（descheduler）
  if (mode === "reinforced" && deps.countPendingByRole && deps.spawnReinforced) {
    const roleThreshold = cfg.roleThreshold ?? 5;
    const byRole = await deps.countPendingByRole();
    const top = Object.entries(byRole).sort((a, b) => b[1] - a[1])[0];
    const [batchCount] = await Promise.all([deps.batchCount()]);
    if (top && top[1] > roleThreshold && batchCount < cfg.max) {
      await deps.spawnReinforced(top[0], cfg.reinforceCopies ?? 2);
      return { action: "scale-up", reason: `reinforced: ${top[0]} 队列 ${top[1]} > 阈值 ${roleThreshold} → 强化 ×${cfg.reinforceCopies ?? 2}` };
    }
    return { action: "keep", reason: `reinforced: 无角色积压超阈值（top=${top?.[0] ?? "-"}:${top?.[1] ?? 0}）` };
  }

  const [pendingCount, batchCount, idleRatio] = await Promise.all([
    deps.countPending(),
    deps.batchCount(),
    deps.avgIdleRatio(),
  ]);
  const decision = decideScale({ pendingCount, idleRatio, batchCount, ...cfg });
  if (decision.action === "scale-up") {
    await deps.spawnBatch();
    deps.logger?.(`[autoscale] scale-up: ${decision.reason}`);
  } else if (decision.action === "scale-down") {
    const ok = await deps.killOneIdle();
    if (ok) deps.logger?.(`[autoscale] scale-down: ${decision.reason}`);
    else return { action: "keep", reason: "scale-down 失败（无 idle batch）" };
  }
  deps.onScale?.(decision);
  return decision;
}

/** 从 env 加载扩缩容配置（参数化） */
export function loadScalerConfig(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  min: number;
  max: number;
  intervalMs: number;
  upThreshold: number;
} {
  const min = Number(env.PTH_BATCH_MIN ?? 1);
  const max = Number(env.PTH_BATCH_MAX ?? 4);
  const interval = Number(env.PTH_BATCH_SCALE_INTERVAL_MS ?? 30_000);
  const threshold = Number(env.PTH_BATCH_SCALE_UP_THRESHOLD ?? 5);
  return {
    // 默认 off（单大 batch 化：worker 级控制为主——batch 级扩缩特殊手段显式开启）
    enabled: env.PTH_BATCH_AUTOSCALE === "on",
    min: Number.isFinite(min) && min >= 0 ? min : 1,
    max: Number.isFinite(max) && max >= min ? max : Math.max(min, 4),
    intervalMs: Number.isFinite(interval) && interval >= 5_000 ? interval : 30_000,
    upThreshold: Number.isFinite(threshold) && threshold >= 1 ? threshold : 5,
  };
}

// 复用 BatchSuggestion 类型（保持契约收敛）
export type { BatchSuggestion };
