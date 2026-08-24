/**
 * tasking/tool-reg-builtin.ts —— N14 P0 存量登记器（2026-08-18，Q4 裁决：一次性全登记）。
 *
 * 依据 docs/pth/design/n14-sensor-controller-four-dims.md §3.6：
 *   存量硬编码工具全部登记为 builtin 条目（executor.ref = 执行器键）——
 *   **执行完全不动**（仍走硬编码函数表——零行为变化），条目承担治理面
 *   （description 三要素统一 / 可见性声明 / 包归属 / 版本起点 v1）；
 *   visibility 初值 = 现状推导（各角色 actionTools 声明的并集——登记不改变任何角色的
 *   实际可见面，只把隐式声明显式化）；
 *   双写一致性对账：reconcileBuiltinToolRegs() —— 注册表 builtin 条目集 ≡
 *   PTC_TOOL_DEFS 键集（名称/包归属/三要素齐备 + 执行器引用可解析）。
 *
 * 消费方：
 *   - scripts/seed-tool-reg.ts（幂等 seed 脚本——seed-wiki 同款）；
 *   - test/pth-tasking/tool-reg-builtin.test.ts（对账钉测试）。
 *
 * 数量事实（2026-08-18 盘点——N14 设计文档写 35 为 B6 退役前旧数）：
 *   PTC_TOOL_DEFS 33 条 = AGENT_TOOLS 27 执行器（含 done 兜底执行器；done 另有
 *   agent-loop 固定协议特殊处理——result 契约/ASP 元空间门控）+ ASP-only 6
 *   （asp.cd/asp.index/memory.index/cache.load/cache.index/cache.cancel——agent-loop ASP 内联执行）。
 *   ref 约定：27 键直引 AGENT_TOOLS；ASP-only 6 件 ref="asp-inline:<name>"。
 */

import { PTC_TOOL_DEFS } from "@away_from/pth-kernel-interpreter";
import { ASP_ONLY_TOOLS, TOOL_GROUPS, expandToolGroups } from "@away_from/pth-kernel-execution";
import { AGENT_TOOLS } from "@away_from/pth-kernel-execution";
import { DEFAULT_ROLES, GOVERNANCE_ROLES, MID_ROLES } from "@away_from/pth-kernel-execution";
import { buildToolRegContent, type ToolRegSpec } from "@away_from/pth-memory";

/** done 的工具包归属（固定协议——不在任何工具族内） */
export const TOOL_REG_CORE_PACK = "core";

/** 全部内置角色（登记推导面——MID + DEFAULT + GOVERNANCE） */
const ALL_BUILTIN_ROLES = [...MID_ROLES, ...DEFAULT_ROLES, ...GOVERNANCE_ROLES];

/**
 * 隐式全面角色（未声明 actionTools——filterToolSchemas 缺省全量，向后兼容规则）。
 * 这些角色现状可见全部工具；visibility.roles 只录显式声明并集（设计原文），
 * 本清单进 seed meta.implicitFullFace 供 P2 动态工具面保持现状语义。
 */
export function implicitFullFaceRoles(): string[] {
  return ALL_BUILTIN_ROLES.filter((r) => !r.actionTools || r.actionTools.length === 0).map((r) => r.id).sort();
}

/** 工具包反查（TOOL_GROUPS 族名；无族 → core——当前仅 done） */
export function toolPackOf(toolName: string): string {
  for (const [group, tools] of Object.entries(TOOL_GROUPS)) {
    if (tools.includes(toolName)) return group;
  }
  return TOOL_REG_CORE_PACK;
}

/**
 * builtin 执行器引用（执行面诚实记录）：
 *   AGENT_TOOLS 键（含 done 兜底执行器）→ 键本身；ASP-only → asp-inline:<name>。
 */
export function builtinExecutorRef(toolName: string): string {
  if (ASP_ONLY_TOOLS.has(toolName)) return `asp-inline:${toolName}`;
  return toolName;
}

/** visibility 推导：各角色 actionTools 声明（族展开后）含该工具的并集——排序保证确定性 */
export function deriveVisibilityRoles(toolName: string): string[] {
  const declared = ALL_BUILTIN_ROLES.filter((r) => r.actionTools && r.actionTools.length > 0);
  // done/pause 属固定协议段（toolsDescription 固定输出，不走工具族声明）——全声明角色可见
  if (toolName === "done" || toolName === "pause") return declared.map((r) => r.id).sort();
  return declared
    .filter((r) => expandToolGroups(r.actionTools as string[]).includes(toolName))
    .map((r) => r.id)
    .sort();
}

/** 单条 PTC_TOOL_DEFS → builtin tool-reg spec（version 起点 1） */
export function buildBuiltinToolRegSpec(name: string): ToolRegSpec {
  const def = PTC_TOOL_DEFS.find((d) => d.name === name);
  if (!def) throw new Error(`tool-reg builtin 登记：PTC_TOOL_DEFS 无 "${name}"`);
  return {
    name: def.name,
    version: 1,
    description: { anchor: def.anchor, whenToUse: def.whenToUse, effect: def.effect },
    parameters: { type: "object", properties: def.properties, required: def.required },
    executor: { type: "builtin", ref: builtinExecutorRef(def.name) },
    command: `builtin:${builtinExecutorRef(def.name)}`,
    visibility: { roles: deriveVisibilityRoles(def.name), pack: toolPackOf(def.name) },
  };
}

export interface BuiltinToolRegSeed {
  specs: ToolRegSpec[];
  implicitFullFaceRoles: string[];
}

/** 存量全登记（PTC_TOOL_DEFS 顺序 = prompt 文本顺序——确定性输出） */
export function buildBuiltinToolRegEntries(): BuiltinToolRegSeed {
  return {
    specs: PTC_TOOL_DEFS.map((d) => buildBuiltinToolRegSpec(d.name)),
    implicitFullFaceRoles: implicitFullFaceRoles(),
  };
}

export interface ToolRegReconcileReport {
  ok: boolean;
  issues: string[];
}

/**
 * 双写一致性对账（§3.6 钉测试落点）：
 *   ① 条目集 ≡ PTC_TOOL_DEFS 键集（无缺/无多）；
 *   ② 每条三要素/parameters 与 def 逐字段一致（生成即漂移防护）；
 *   ③ 包归属 ≡ TOOL_GROUPS 反查（done ≡ core）；
 *   ④ 执行器引用可解析：AGENT_TOOLS 键真实存在（含 done 兜底键）/ asp-inline 恰为 ASP-only 集；
 *   ⑤ visibility.roles 非空且与 actionTools 推导一致。
 */
export function reconcileBuiltinToolRegs(specs: ToolRegSpec[]): ToolRegReconcileReport {
  const issues: string[] = [];
  const defNames = PTC_TOOL_DEFS.map((d) => d.name);
  const specNames = specs.map((s) => s.name);
  for (const n of defNames.filter((n) => !specNames.includes(n))) issues.push(`缺条目：${n}`);
  for (const n of specNames.filter((n) => !defNames.includes(n))) issues.push(`多条目：${n}`);
  const aspInlineNames = specs.filter((s) => s.executor.type === "builtin" && s.executor.ref.startsWith("asp-inline:")).map((s) => s.name).sort();
  const aspOnlyNames = [...ASP_ONLY_TOOLS].sort();
  if (JSON.stringify(aspInlineNames) !== JSON.stringify(aspOnlyNames)) {
    issues.push(`asp-inline 集漂移：条目 [${aspInlineNames.join(",")}] ≠ ASP_ONLY_TOOLS [${aspOnlyNames.join(",")}]`);
  }
  for (const s of specs) {
    const def = PTC_TOOL_DEFS.find((d) => d.name === s.name);
    if (!def) continue;   // 多条目已在上面记录
    if (s.executor.type !== "builtin") { issues.push(`${s.name}：executor 应为 builtin（存量登记）`); continue; }
    const ref = s.executor.ref;
    if (s.command !== `builtin:${ref}`) issues.push(`${s.name}：command 应为 builtin:${ref}（Tool-Reg v2）`);
    if (ASP_ONLY_TOOLS.has(s.name)) {
      if (ref !== `asp-inline:${s.name}`) issues.push(`${s.name}：ASP-only 条目 ref 应为 asp-inline:${s.name}（实 ${ref}）`);
    } else if (!(ref in AGENT_TOOLS)) {
      issues.push(`${s.name}：ref "${ref}" 不在 AGENT_TOOLS 执行器表（新增硬编码工具必须接线执行器或登记为 ASP-only）`);
    } else if (ref !== s.name) {
      issues.push(`${s.name}：builtin ref 应等于工具名（实 ${ref}）`);
    }
    if (s.description.anchor !== def.anchor || s.description.whenToUse !== def.whenToUse || s.description.effect !== def.effect) {
      issues.push(`${s.name}：三要素与 PTC_TOOL_DEFS 漂移`);
    }
    if (JSON.stringify(s.parameters.properties) !== JSON.stringify(def.properties)
      || JSON.stringify(s.parameters.required) !== JSON.stringify(def.required)) {
      issues.push(`${s.name}：parameters 与 PTC_TOOL_DEFS 漂移`);
    }
    const pack = toolPackOf(s.name);
    if (s.visibility.pack !== pack) issues.push(`${s.name}：包归属应为 ${pack}（实 ${s.visibility.pack}）`);
    const roles = deriveVisibilityRoles(s.name);
    if (JSON.stringify(s.visibility.roles) !== JSON.stringify(roles)) {
      issues.push(`${s.name}：visibility.roles 与 actionTools 推导漂移（应 [${roles.join(",")}]）`);
    }
  }
  return { ok: issues.length === 0, issues };
}

/** 条目的 memory 落库形态（seed 脚本消费——kind/status/meta 一处组装） */
export function builtinToolRegRow(spec: ToolRegSpec, implicitFullFace: string[]): {
  id: string; kind: "tool-reg"; anchors: string[]; content: string; status: "official"; meta: Record<string, unknown>;
} {
  return {
    id: `tool:${spec.name}`,
    kind: "tool-reg",
    anchors: ["tool-reg", spec.name, spec.visibility.pack, `executor:${spec.executor.type}`],
    content: buildToolRegContent(spec),
    status: "official",
    meta: {
      format: "tool-reg-v1",
      version: spec.version,
      pack: spec.visibility.pack,
      executorType: spec.executor.type,
      implicitFullFace,
      source: "PTC_TOOL_DEFS（存量全登记——Q4 裁决）",
      seeder: "scripts/seed-tool-reg.ts",
    },
  };
}
