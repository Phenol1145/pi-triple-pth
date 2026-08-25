/**
 * ptc/tools.ts —— 工具契约注册表（2026-08-14 A1 Phase 3 条目 10——TOOL_SCHEMAS 生成器）。
 *
 * W0（2026-08-24 ADR-0004）：PTC_TOOL_DEFS 不再手写维护，改为从 PTC_CAPABILITIES 派生——
 * 工具 schema 与能力契约同一真相源（toolSchema 字段）。顺序仍由 PTC_TOOL_ORDER 钉死
 * （prompt 文本顺序；ptc-tools 测试 golden）。
 *
 * description 组装 = 「【场景锚点：A】何时用：W。效果：E。」——与旧手写逐字节一致。
 */

import { PTC_CAPABILITIES } from "./contract.js";

export interface PtcToolDef {
  /** 点形工具名（ts.run / asp.create…） */
  name: string;
  /** 三要素（T8）：场景锚点 */
  anchor: string;
  /** 三要素（T8）：何时用 */
  whenToUse: string;
  /** 三要素（T8）：效果预告 */
  effect: string;
  /** 参数 JSON Schema（OpenAI function 格式 properties——逐字节保留旧值） */
  properties: Record<string, unknown>;
  required: string[];
}

/** 三要素 → 工具描述（与旧手写格式逐字节一致） */
export function renderToolDescription(d: PtcToolDef): string {
  return "【场景锚点：" + d.anchor + "】何时用：" + d.whenToUse + "。效果：" + d.effect + "。";
}

/** 工具契约顺序（prompt 文本顺序——golden 钉死；2026-08-14 N8：35→33；生命周期 P1：pause 加入→34） */
const PTC_TOOL_ORDER = [
  "python.run", "python.eval", "bash.run", "bash.eval", "ts.run", "ts.eval", "done", "pause",
  "dev.write", "dev.edit", "dev.build", "dev.run", "dev.save", "dev.list",
  "debug.attach", "debug.breakpoint", "debug.continue", "debug.step", "debug.snapshot",
  "debug.evaluate", "debug.detach", "debug.sessions",
  "write.create", "write.edit", "write.read", "write.list", "write.save", "write.section",
  "asp.cd", "asp.index", "memory.index",
  "cache.load", "cache.index", "cache.cancel",
] as const;

/** 工具契约注册表（34 条——由 PTC_CAPABILITIES.toolSchema 派生；顺序即 prompt 文本顺序） */
export const PTC_TOOL_DEFS: PtcToolDef[] = PTC_TOOL_ORDER.map((name) => {
  const def = PTC_CAPABILITIES[name];
  if (!def?.toolSchema) {
    throw new Error(`PTC_TOOL_DEFS 派生失败：${name} 缺 toolSchema（请先补齐 PTC_CAPABILITIES 契约）`);
  }
  return {
    name,
    anchor: def.anchor,
    whenToUse: def.whenToUse,
    effect: def.effect,
    properties: def.toolSchema.properties,
    required: def.toolSchema.required,
  };
});

/** TOOL_SCHEMAS 派生（agent-tools 消费——工具面与能力面同一契约源） */
export function buildToolSchemas(): Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> {
  const out: Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> = {};
  for (const d of PTC_TOOL_DEFS) {
    out[d.name] = { description: renderToolDescription(d), properties: d.properties, required: d.required };
  }
  return out;
}
