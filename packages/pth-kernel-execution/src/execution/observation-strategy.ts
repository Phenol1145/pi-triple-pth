/**
 * observation-strategy.ts —— 观察策略 / 活动因子（Wave 1）。
 *
 * v1 只要求声明式策略进热路径；脚本策略（scriptRef）走异步队列，不阻塞 worker。
 * 跨任务窗口的状态归属在 OptimizationLoopRuntime / observation store，不依赖单 worker 内存。
 */

export type ObservationOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "regex";
export type ObservationAggregate = "count" | "rate" | "sum" | "avg" | "p50" | "p95" | "p99" | "distinct";

export interface ObservationCondition {
  readonly field: string;
  readonly op: ObservationOperator;
  readonly value: unknown;
  /** regex/string 比较是否大小写敏感；缺省 true。 */
  readonly caseSensitive?: boolean;
}

export interface ObservationBudget {
  /** regex 源串最大长度；缺省 200。 */
  readonly maxRegexLength?: number;
  /** 单次评估最大样本数；缺省 10000。 */
  readonly maxSamples?: number;
  /** 热路径执行预算（ms）；缺省 50。 */
  readonly maxMs?: number;
}

export interface ObservationStrategySpec {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  /** 声明式条件：全部满足才算命中。 */
  readonly conditions?: readonly ObservationCondition[];
  readonly aggregate?: ObservationAggregate;
  /** sum/avg/percentiles 需要目标字段；count/rate 可省略。 */
  readonly field?: string;
  readonly budget?: ObservationBudget;
  /** 脚本策略：非空时不得在 worker 热路径同步求值。 */
  readonly scriptRef?: string;
  readonly tags?: readonly string[];
}

export interface ActivityFactor {
  readonly id: string;
  readonly strategyId: string;
  readonly observedAt: number;
  /** 命中的样本快照（可裁剪；可选）。 */
  readonly sample?: unknown;
  /** 因子数值。 */
  readonly value: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class ObservationStrategyError extends Error {
  readonly code = "observation-strategy-error";
  constructor(message: string) {
    super(message);
    this.name = "ObservationStrategyError";
  }
}

const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

// ── 字段路径 matcher ───────────────────────────────────────────────

/**
 * 读取嵌套字段路径，支持点号与数组下标：`a.b[0].c`。
 * 找不到返回 undefined。
 */
export function getPathValue(input: unknown, path: string): unknown {
  if (!NON_EMPTY_STRING(path)) return undefined;
  const tokens = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((t) => t.length > 0);
  let cur: unknown = input;
  for (const token of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[token];
  }
  return cur;
}

function normalizeForCompare(v: unknown, caseSensitive: boolean): unknown {
  return typeof v === "string" && !caseSensitive ? v.toLowerCase() : v;
}

/** 单条件匹配。 */
export function matchObservationCondition(sample: unknown, cond: ObservationCondition): boolean {
  const actual = getPathValue(sample, cond.field);
  const cs = cond.caseSensitive ?? true;
  const expected = normalizeForCompare(cond.value, cs);
  const actualNorm = normalizeForCompare(actual, cs);

  switch (cond.op) {
    case "eq": return actualNorm === expected;
    case "ne": return actualNorm !== expected;
    case "gt": return typeof actualNorm === "number" && typeof expected === "number" && actualNorm > expected;
    case "gte": return typeof actualNorm === "number" && typeof expected === "number" && actualNorm >= expected;
    case "lt": return typeof actualNorm === "number" && typeof expected === "number" && actualNorm < expected;
    case "lte": return typeof actualNorm === "number" && typeof expected === "number" && actualNorm <= expected;
    case "contains": {
      if (typeof actualNorm === "string" && typeof expected === "string") return actualNorm.includes(expected);
      if (Array.isArray(actual)) return (actual as unknown[]).some((v) => normalizeForCompare(v, cs) === expected);
      return false;
    }
    case "regex": {
      if (typeof actual !== "string" || typeof cond.value !== "string") return false;
      try {
        const flags = cs ? "" : "i";
        return new RegExp(cond.value, flags).test(actual);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

function matchesAllConditions(sample: unknown, conditions: readonly ObservationCondition[] | undefined): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((c) => matchObservationCondition(sample, c));
}

// ── 聚合器 ─────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

export function computeObservationAggregate(
  aggregate: ObservationAggregate,
  matched: readonly unknown[],
  total: number,
  field?: string,
): number {
  const values = matched
    .map((s) => (field ? getPathValue(s, field) : undefined))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  switch (aggregate) {
    case "count":
      return matched.length;
    case "rate":
      return total > 0 ? matched.length / total : 0;
    case "distinct": {
      const raw = matched
        .map((s) => (field ? getPathValue(s, field) : s))
        .filter((v) => v !== undefined && v !== null);
      return new Set(raw.map((v) => (typeof v === "object" ? JSON.stringify(v) : v))).size;
    }
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    case "p50":
    case "p95":
    case "p99": {
      const sorted = [...values].sort((a, b) => a - b);
      const p = aggregate === "p50" ? 50 : aggregate === "p95" ? 95 : 99;
      return percentile(sorted, p);
    }
    default:
      return 0;
  }
}

export function validateObservationStrategySpec(spec: ObservationStrategySpec): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!NON_EMPTY_STRING(spec.id)) errors.push("id is required");
  if (spec.scriptRef && spec.conditions && spec.conditions.length > 0) {
    errors.push("script strategy must not declare hot-path conditions");
  }
  if (spec.budget?.maxRegexLength !== undefined && (!Number.isInteger(spec.budget.maxRegexLength) || spec.budget.maxRegexLength <= 0)) {
    errors.push("maxRegexLength must be positive integer");
  }
  if (spec.budget?.maxSamples !== undefined && (!Number.isInteger(spec.budget.maxSamples) || spec.budget.maxSamples <= 0)) {
    errors.push("maxSamples must be positive integer");
  }
  if (spec.budget?.maxMs !== undefined && (!Number.isInteger(spec.budget.maxMs) || spec.budget.maxMs <= 0)) {
    errors.push("maxMs must be positive integer");
  }
  for (const cond of spec.conditions ?? []) {
    if (!NON_EMPTY_STRING(cond.field)) errors.push("condition field is required");
    if (cond.op === "regex" && typeof cond.value !== "string") errors.push("regex condition value must be string");
  }
  return { ok: errors.length === 0, errors };
}

export function assertValidObservationStrategySpec(spec: ObservationStrategySpec): void {
  const result = validateObservationStrategySpec(spec);
  if (!result.ok) throw new ObservationStrategyError(`invalid observation strategy ${spec.id}: ${result.errors.join("; ")}`);
}

/**
 * 评估一条声明式观察策略。
 * 脚本策略（scriptRef）直接抛 ObservationStrategyError，禁止热路径同步执行。
 */
export function evaluateObservationStrategy(
  spec: ObservationStrategySpec,
  samples: readonly unknown[],
  opts: { now?: number } = {},
): ActivityFactor {
  assertValidObservationStrategySpec(spec);
  if (spec.scriptRef) {
    throw new ObservationStrategyError(`strategy ${spec.id} is script-based and must run asynchronously, not in hot path`);
  }
  const budget = spec.budget ?? {};
  const maxSamples = budget.maxSamples ?? 10_000;
  const maxRegexLength = budget.maxRegexLength ?? 200;
  const maxMs = budget.maxMs ?? 50;

  if (samples.length > maxSamples) {
    throw new ObservationStrategyError(`strategy ${spec.id} exceeds maxSamples (${samples.length} > ${maxSamples})`);
  }

  const started = Date.now();
  const matched: unknown[] = [];
  for (const s of samples) {
    const conds = spec.conditions ?? [];
    for (const cond of conds) {
      if (cond.op === "regex" && typeof cond.value === "string" && cond.value.length > maxRegexLength) {
        throw new ObservationStrategyError(`strategy ${spec.id} regex exceeds maxRegexLength (${cond.value.length} > ${maxRegexLength})`);
      }
    }
    if (matchesAllConditions(s, conds)) matched.push(s);
    if (Date.now() - started > maxMs) {
      throw new ObservationStrategyError(`strategy ${spec.id} exceeded maxMs (${maxMs})`);
    }
  }

  const aggregate = spec.aggregate ?? "count";
  const value = computeObservationAggregate(aggregate, matched, samples.length, spec.field);

  return {
    id: `activity-factor:${spec.id}:${Date.now().toString(36)}`,
    strategyId: spec.id,
    observedAt: opts.now ?? Date.now(),
    ...(matched.length > 0 ? { sample: matched[0] } : {}),
    value,
    metadata: { matched: matched.length, total: samples.length, aggregate },
  };
}
