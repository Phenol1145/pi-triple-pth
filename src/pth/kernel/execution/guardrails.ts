/**
 * guardrails.ts —— 护栏注册表（2026-08-14 N12——护栏统一抽象）。
 *
 * 认知模型（concepts.md §10.1）：护栏 = 0.14 伪世界模型「相变预警」的微观版——
 * 检测系统从「可预测层」滑向「失控层」，在相变点前制动。
 *
 * 统一三段式：
 *   观测（signal）——每步事件（hit/reset）由调用点判定（指纹比对/负结果语义/空 done——
 *   信号来源各异，保留在调用点）；
 *   判定（verdict）——守卫实例持有连续计数 + 阈值——阈值全走配置中心
 *   （perf-params PTH_GUARD_* 键，运行时可调）；
 *   处置（action）——语义统一：guide（回填引导消息继续）/ soft（软终止 ok+warning）/
 *   hard（硬失败 ok:false）。
 *
 * 豁免矩阵声明式（GUARD_EXEMPTIONS）：T5 侦察豁免（negative-loop → scout/explorer）
 * 进矩阵；治理族豁免已裁决不做（2026-08-15 D2 custom）——改为负结果收敛阈值
 * 5→15 全局放宽（给 sensor 留观测窗口；失败任务回收机制缺失期不过早强制闭合）。
 */

export interface GuardContext {
  roleId?: string;
  tool: string;
  steps: number;
}

/** 统一处置判定 */
export interface GuardVerdict {
  kind: "none" | "guide" | "soft" | "hard";
  /** 连续命中计数（未命中/豁免时 0） */
  count: number;
  /** 生效阈值（配置中心解析后——guide 文案的「剩余机会」用） */
  limit: number;
}

export interface ConsecutiveGuardDef {
  id: string;
  /** perf-params 阈值键（PTH_GUARD_*——运行时可调） */
  limitKey: string;
  limitDefault: number;
  /** 引导起点（第 N 次命中起 guide——不设则无引导、直接到 limit） */
  guideAt?: number;
  /** 处置语义：soft=软终止（ok+warning）；hard=硬失败（ok:false） */
  mode: "soft" | "hard";
  /** 豁免谓词（豁免时不计数、不处置） */
  exempt?: (ctx: GuardContext) => boolean;
}

/** 连续计数守卫——五种「计数→引导→终止」手写模式的统一形态 */
export class ConsecutiveGuard {
  readonly id: string;
  private count = 0;

  constructor(
    private def: ConsecutiveGuardDef,
    private getLimit: (key: string, fallback: number) => number,
  ) {
    this.id = def.id;
  }

  /** 每步调用：hit=true 计一次；false 重置计数。返回统一处置判定。 */
  step(ctx: GuardContext, hit: boolean): GuardVerdict {
    const limit = this.getLimit(this.def.limitKey, this.def.limitDefault);
    if (!hit) {
      this.count = 0;
      return { kind: "none", count: 0, limit };
    }
    if (this.def.exempt?.(ctx)) return { kind: "none", count: this.count, limit };
    this.count++;
    if (this.count >= limit) return { kind: this.def.mode, count: this.count, limit };
    if (this.def.guideAt !== undefined && this.count >= this.def.guideAt) {
      return { kind: "guide", count: this.count, limit };
    }
    return { kind: "none", count: this.count, limit };
  }

  reset(): void {
    this.count = 0;
  }
}

/** 内置守卫定义（agent-loop 五计数器收敛——§10.1 首个实例集） */
export const GUARD_DEFS: Record<string, ConsecutiveGuardDef> = {
  "repeat-action": { id: "repeat-action", limitKey: "PTH_GUARD_REPEAT_LIMIT", limitDefault: 5, guideAt: 3, mode: "soft" },
  "empty-done": { id: "empty-done", limitKey: "PTH_GUARD_EMPTY_DONE_LIMIT", limitDefault: 3, mode: "hard" },
  "empty-reply": { id: "empty-reply", limitKey: "PTH_GUARD_EMPTY_REPLY_LIMIT", limitDefault: 3, mode: "hard" },
  "unknown-tool": { id: "unknown-tool", limitKey: "PTH_GUARD_UNKNOWN_TOOL_LIMIT", limitDefault: 3, mode: "hard" },
};

/**
 * A4 护栏 JIT 可放宽白名单（2026-08-18）：仅软处置/负结果族可自动建议放宽——
 * empty-done/empty-reply/unknown-tool 是 hard 契约护栏，只许人工调，不自动建议。
 */
export const GUARD_TUNABLE_DEFS: Record<string, { limitKey: string; default: number; mode: "soft" }> = {
  "negative-loop": { limitKey: "PTH_GUARD_NEGATIVE_LIMIT", default: 15, mode: "soft" },
  "repeat-action": { limitKey: "PTH_GUARD_REPEAT_LIMIT", default: 5, mode: "soft" },
};

/** 豁免矩阵（声明式——2026-08-14 T5 裁决进矩阵；治理族豁免 2026-08-15 D2 裁为不做——阈值放宽替代） */
export const GUARD_EXEMPTIONS: Record<string, (ctx: GuardContext) => boolean> = {
  // T5：侦察类豁免负结果收敛强制终止（合法多源探测——maxSteps 兜底）
  "negative-loop": (ctx) => ctx.roleId === "scout" || ctx.roleId === "explorer",
};

export interface GuardRegistry {
  /** 取连续守卫实例（每个任务循环一组——计数随任务重置） */
  guard(id: string): ConsecutiveGuard;
  /** 豁免矩阵判定 */
  exempt(id: string, ctx: GuardContext): boolean;
  /** 负结果收敛阈值（negativeLoopCheck 消费——配置键） */
  negativeLimits(): { terminate: number; guideAt: number };
}

/** 创建护栏注册表（getLimit = perf-params configNumber——阈值运行时可调） */
export function createGuardRegistry(getLimit: (key: string, fallback: number) => number): GuardRegistry {
  const guards = new Map<string, ConsecutiveGuard>();
  return {
    guard(id: string): ConsecutiveGuard {
      const def = GUARD_DEFS[id];
      if (!def) throw new Error("guardrails: 未注册的护栏 " + id);
      let g = guards.get(id);
      if (!g) {
        g = new ConsecutiveGuard(def, getLimit);
        guards.set(id, g);
      }
      return g;
    },
    exempt(id: string, ctx: GuardContext): boolean {
      return GUARD_EXEMPTIONS[id]?.(ctx) ?? false;
    },
    negativeLimits(): { terminate: number; guideAt: number } {
      return {
        terminate: getLimit("PTH_GUARD_NEGATIVE_LIMIT", 15),
        guideAt: getLimit("PTH_GUARD_NEGATIVE_GUIDE_AT", 3),
      };
    },
  };
}

