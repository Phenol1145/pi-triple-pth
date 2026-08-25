/**
 * optimization-loop-spec.ts —— 规范化优化循环的统一规格（Wave 1）。
 *
 * 目标：所有优化环共享同一骨架 Sense → Detect → Propose → Govern → Apply → Verify → Deopt，
 * 而不是每套优化各写一套调度/观测/提案/回滚逻辑。
 *
 * 本文件只放纯类型与校验函数；运行编排在 optimization-loop-runtime.ts。
 */

/** 执行模式（Wave 3 会成为唯一入口；此处先作为共享纯类型，避免 Wave 1 反向依赖 runner/config）。 */
export type ExecMode = "tool-call" | "asp" | "ptc" | "pulse";

/** CommandErrorClass（Wave 2 会扩展 CommandFeedback；此处先共享纯类型供 ActivityFactor/观测使用）。 */
export type CommandErrorClass =
  | "tool-schema"
  | "adapter-not-found"
  | "adapter-config"
  | "target-resolution"
  | "authorization"
  | "execution"
  | "tool-contract"
  | "adapter-exception";

// ── Sensor ─────────────────────────────────────────────────────────

export type LoopSensorKind = "code" | "role" | "hybrid";

interface LoopSensorBase {
  readonly kind: LoopSensorKind;
  /** sensor 只读：任何实现不得在 Sense 阶段写资产。 */
  readonly readOnly: true;
}

export interface CodeLoopSensor extends LoopSensorBase {
  readonly kind: "code";
  /** 代码策略引用（registry id / source ref）。 */
  readonly ref: string;
}

export interface RoleLoopSensor extends LoopSensorBase {
  readonly kind: "role";
  /** 角色任务型 sensor 的角色 id。 */
  readonly roleId: string;
  /** 可选模板 id，用于任务化 sensor 的渲染。 */
  readonly taskTemplateId?: string;
}

export interface HybridLoopSensor extends LoopSensorBase {
  readonly kind: "hybrid";
  /** 代码策略引用。 */
  readonly ref: string;
  /** 角色任务型 sensor 的角色 id。 */
  readonly roleId: string;
  readonly taskTemplateId?: string;
}

export type LoopSensor = CodeLoopSensor | RoleLoopSensor | HybridLoopSensor;

// ── Schedule ───────────────────────────────────────────────────────

export type LoopScheduleKind = "event" | "task-finish" | "window" | "interval" | "manual";

interface LoopScheduleBase {
  readonly kind: LoopScheduleKind;
}

export interface EventLoopSchedule extends LoopScheduleBase {
  readonly kind: "event";
  readonly events: readonly string[];
}

export interface TaskFinishLoopSchedule extends LoopScheduleBase {
  readonly kind: "task-finish";
  /** 每 N 个任务完成触发一次；缺省 1。 */
  readonly everyNTasks?: number;
}

export interface WindowLoopSchedule extends LoopScheduleBase {
  readonly kind: "window";
  readonly windowSize: number;
  /** fixed = 窗口内固定任务量；sliding = 滑动窗口。缺省 fixed。 */
  readonly windowType?: "fixed" | "sliding";
}

export interface IntervalLoopSchedule extends LoopScheduleBase {
  readonly kind: "interval";
  readonly intervalMs: number;
}

export interface ManualLoopSchedule extends LoopScheduleBase {
  readonly kind: "manual";
}

export type LoopSchedule =
  | EventLoopSchedule
  | TaskFinishLoopSchedule
  | WindowLoopSchedule
  | IntervalLoopSchedule
  | ManualLoopSchedule;

// ── Governance / Verify ────────────────────────────────────────────

/** applyChannel：auto 表示可自动部署；auto-reversible 必须带 rollbackRef；approval 走审批；manual 永远人工。 */
export type ApplyChannel = "auto" | "auto-reversible" | "approval" | "manual";

export interface LoopGovernance {
  readonly applyChannel: ApplyChannel;
  /** 安全敏感目标（target/backend/external/config-change/adapter-proposal 等）不得 auto-reversible。 */
  readonly safetySensitive?: boolean;
  /** 提案存储引用（draft 落点）。 */
  readonly proposalStoreRef?: string;
  /** 审批角色/通道；approval/manual 时建议填写。 */
  readonly requiredApprovals?: readonly string[];
  /** auto-reversible 时必须声明回滚引用。 */
  readonly rollbackRef?: string;
}

export interface LoopVerifyPolicy {
  /** verify 是必备节点；false 仅允许显式后置（需在 spec.migrationStatus 标注）。 */
  readonly required: boolean;
  /** 基线引用；缺失时 verify 不得静默 active。 */
  readonly baselineRef?: string;
  readonly timeoutMs?: number;
  readonly evidenceRefs?: readonly string[];
  readonly deoptOn?: readonly ("degraded" | "timeout" | "manual")[];
}

export interface LoopBudget {
  readonly maxIterations?: number;
  readonly maxDurationMs?: number;
}

export interface OptimizationLoopSpec {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly sensor: LoopSensor;
  readonly schedule: LoopSchedule;
  readonly governance: LoopGovernance;
  readonly verify: LoopVerifyPolicy;
  readonly budget?: LoopBudget;
  /** native = 原生规范化 loop；wrapped = 现有优化器包装；registered-only = 只登记、未改造。 */
  readonly migrationStatus?: "native" | "wrapped" | "registered-only";
  readonly owner?: string;
  readonly tags?: readonly string[];
}

// ── 校验 ───────────────────────────────────────────────────────────

export interface LoopSpecValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function validateOptimizationLoopSpec(spec: OptimizationLoopSpec): LoopSpecValidationResult {
  const errors: string[] = [];
  if (!NON_EMPTY_STRING(spec.id)) errors.push("id is required");
  if (!NON_EMPTY_STRING(spec.name)) errors.push("name is required");

  if (spec.sensor.readOnly !== true) errors.push("sensor must be readOnly");

  if (spec.schedule.kind === "window") {
    if (!Number.isInteger(spec.schedule.windowSize) || spec.schedule.windowSize <= 0) {
      errors.push("window schedule requires positive integer windowSize");
    }
  }
  if (spec.schedule.kind === "interval") {
    if (!Number.isInteger(spec.schedule.intervalMs) || spec.schedule.intervalMs <= 0) {
      errors.push("interval schedule requires positive intervalMs");
    }
  }
  if (spec.schedule.kind === "event" && (!Array.isArray(spec.schedule.events) || spec.schedule.events.length === 0)) {
    errors.push("event schedule requires non-empty events");
  }
  if (spec.schedule.kind === "task-finish") {
    const n = spec.schedule.everyNTasks;
    if (n !== undefined && (!Number.isInteger(n) || n <= 0)) errors.push("task-finish everyNTasks must be positive integer");
  }

  if (spec.governance.applyChannel === "auto-reversible") {
    if (!NON_EMPTY_STRING(spec.governance.rollbackRef)) {
      errors.push("auto-reversible requires rollbackRef");
    }
    if (spec.governance.safetySensitive === true) {
      errors.push("safety-sensitive applyChannel cannot use auto-reversible");
    }
  }

  if (spec.verify.required === true) {
    // verify 是必备节点：没有基线/证据/超时时不能静默保持 active（至少显式标记 migrationStatus=registered-only 可后置）。
    if (spec.migrationStatus !== "registered-only") {
      if (!spec.verify.baselineRef && (!spec.verify.evidenceRefs || spec.verify.evidenceRefs.length === 0) && !spec.verify.timeoutMs) {
        errors.push("verify required but no baselineRef/evidenceRefs/timeoutMs is declared");
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** 简单断言式校验：不合法直接抛错（注册/装配点用）。 */
export function assertValidOptimizationLoopSpec(spec: OptimizationLoopSpec): void {
  const result = validateOptimizationLoopSpec(spec);
  if (!result.ok) {
    throw new Error(`invalid optimization loop spec ${spec.id}: ${result.errors.join("; ")}`);
  }
}
