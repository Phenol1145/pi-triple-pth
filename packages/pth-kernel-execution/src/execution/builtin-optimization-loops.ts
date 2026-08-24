/**
 * builtin-optimization-loops.ts —— 内置优化循环登记（Wave 1）。
 *
 * 只有 JIT 是 wrapped；其余优化环先以 registered-only 登记，声明迁移状态，
 * 不要求本 Wave 全部改造为原生 loop。
 */

import type { OptimizationLoopRegistry } from "./optimization-loop-runtime.js";
import type { OptimizationLoopSpec } from "./optimization-loop-spec.js";

export const BUILTIN_OPTIMIZATION_LOOP_SPECS: readonly OptimizationLoopSpec[] = [
  {
    id: "optimization-loop:refiner",
    name: "Refiner differentiation (registered-only)",
    description: "角色分化/窄域角色提案环；当前仍走 refiner 独立路径，先登记骨架。",
    sensor: { kind: "role", roleId: "refiner", readOnly: true },
    schedule: { kind: "event", events: ["task-finish", "differentiation-proposal"] },
    governance: { applyChannel: "approval", requiredApprovals: ["supervisor"] },
    verify: { required: true, deoptOn: ["degraded"] },
    migrationStatus: "registered-only",
    owner: "refiner",
    tags: ["refiner", "role-differentiation"],
  },
  {
    id: "optimization-loop:perf-autopilot",
    name: "Perf autopilot (registered-only)",
    description: "性能自动调参环；当前独立 perf-autopilot 路径，先登记。",
    sensor: { kind: "code", ref: "perf-metrics", readOnly: true },
    schedule: { kind: "interval", intervalMs: 60_000 },
    governance: { applyChannel: "approval", requiredApprovals: ["supervisor"] },
    verify: { required: true, deoptOn: ["degraded", "timeout"] },
    migrationStatus: "registered-only",
    owner: "perf-autopilot",
    tags: ["perf", "autopilot"],
  },
  {
    id: "optimization-loop:tool-skill-governance",
    name: "Tool/Skill governance (registered-only)",
    description: "工具/技能治理提案环；当前独立 tool/skill 治理路径，先登记。",
    sensor: { kind: "code", ref: "tool-skill-proposal-sensor", readOnly: true },
    schedule: { kind: "event", events: ["tool-proposal", "skill-proposal"] },
    governance: { applyChannel: "approval", requiredApprovals: ["tool-governor"] },
    verify: { required: true, deoptOn: ["degraded"] },
    migrationStatus: "registered-only",
    owner: "tool-skill-governance",
    tags: ["tool", "skill", "governance"],
  },
  {
    id: "optimization-loop:intake-feedback",
    name: "Knowledge intake feedback (registered-only)",
    description: "Knowledge Intake 反馈环；Intake 不走通用 taskflow，本登记只表达观测/治理边界。",
    sensor: { kind: "code", ref: "intake-metrics", readOnly: true },
    schedule: { kind: "task-finish", everyNTasks: 10 },
    governance: { applyChannel: "approval", requiredApprovals: ["intake-reviewer"] },
    verify: { required: true, deoptOn: ["degraded"] },
    migrationStatus: "registered-only",
    owner: "knowledge-intake",
    tags: ["intake", "feedback"],
  },
];

export function registerBuiltinOptimizationLoops(registry: OptimizationLoopRegistry): void {
  for (const spec of BUILTIN_OPTIMIZATION_LOOP_SPECS) {
    registry.register({ spec, handler: {
      async sense() { return undefined; },
      async detect() { return []; },
      async govern() { return []; },
      async apply() { return []; },
      async verify() { return []; },
      async deopt() { return []; },
    } });
  }
}
