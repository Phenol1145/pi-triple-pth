/**
 * ptc/docs.ts —— 能力索引文档生成器（2026-08-14 A1 Phase 2 修订条目 8）。
 *
 * capability-index 从注册表生成（三要素格式——T8 锚点标准）：
 * 手写散文退役，文档与契约同一真相源（改注册表即改文档）。
 * 分节按 family 分组（对齐 prompt-docs 分节约定：基础/memory/fs/执行核/web/llm/state/ext/env）。
 *
 * 接线状态：生成器已建 + 测试覆盖；prompt-docs 切换待对齐 golden 断言后另行提交。
 */

import { PTC_CAPABILITIES, type PtcCapabilityDef, type PtcFamily } from "./contract.js";

const FAMILY_SECTIONS: Array<{ family: PtcFamily | "*"; title: string }> = [
  { family: "seed", title: "基础（预置对象）" },
  { family: "memory", title: "memory" },
  { family: "fs", title: "fs" },
  { family: "kernel", title: "执行核" },
  { family: "llm", title: "llm" },
  { family: "web", title: "web" },
  { family: "env", title: "env" },
  { family: "state", title: "state" },
  { family: "cache", title: "cache" },
  { family: "ts-local", title: "扩展面" },
];

/** 单条目三要素行（签名 → 返回 + 何时用 + 效果——T8 锚点格式） */
export function renderCapabilityLine(d: PtcCapabilityDef): string {
  const sig = d.name + d.params + " → " + d.returnType;
  const parts = ["- " + sig, "【场景锚点】" + d.anchor, "何时用：" + d.whenToUse, "效果：" + d.effect];
  if (d.note) parts.push("（" + d.note + "）");
  return parts.join(" —— ");
}

/** 全量能力索引文档（注册表 → markdown） */
export function buildCapabilityIndexDoc(): string {
  const byFamily = new Map<PtcFamily, PtcCapabilityDef[]>();
  for (const def of Object.values(PTC_CAPABILITIES)) {
    const list = byFamily.get(def.family) ?? [];
    list.push(def);
    byFamily.set(def.family, list);
  }
  const lines: string[] = [];
  for (const sec of FAMILY_SECTIONS) {
    const defs = sec.family === "*" ? [] : byFamily.get(sec.family) ?? [];
    if (defs.length === 0) continue;
    lines.push("## " + sec.title);
    for (const d of defs) lines.push(renderCapabilityLine(d));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** 单能力三要素文档（role-doc 对齐/工具描述生成用） */
export function renderCapabilityDoc(name: string): string | undefined {
  const def = PTC_CAPABILITIES[name];
  return def ? renderCapabilityLine(def) : undefined;
}

