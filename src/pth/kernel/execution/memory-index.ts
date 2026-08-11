/**
 * memory-index —— memory.index 图导航构造（ASP v2——2026-08-10）。
 *
 * 拓扑：条目 ←→ tag（anchors）二部图——严格单跳（用户裁决）：
 *   无参     → 顶层视图（四层 + kind 概览 + tag 词表计数——不列条目，防输出爆炸）
 *   {tag}    → 该 tag 关联条目清单（id+kind+摘要——可见性过滤已生效于 wrapper）
 *   {id}     → 条目的 tag 列表 + 摘要（条目 → 出边）
 *
 * 输出纪律：每层 ≤ ~1.9KB（单层永远可读完）。
 */

import { layerOfKind } from "../extensions/memory-policy.js";
import { isVisible } from "./memory-visibility.js";

const MAX_LAYER_CHARS = 1900;

function trunc(s: string): string {
  return s.length <= MAX_LAYER_CHARS ? s : s.slice(0, MAX_LAYER_CHARS) + "…(截断——用 {tag}/{id} 深入)";
}

interface MemoryLike {
  query(sql: string): Promise<unknown>;
  retrieve(opts: { anchors?: string[]; kinds?: string[]; status?: string[] }): Promise<Array<{ id: string; kind: string; anchors: string[]; content: string; meta?: Record<string, unknown> }>>;
  get(id: string): Promise<{ id: string; kind: string; anchors: string[]; content: string; meta?: Record<string, unknown> } | undefined>;
}

/** 顶层视图：层 × kind 计数 + tag 词表（计数降序） */
async function topView(memory: MemoryLike): Promise<string> {
  const kinds = (await memory.query(
    "SELECT kind, count(*) AS n FROM memory_entries GROUP BY kind ORDER BY n DESC LIMIT 30",
  )) as Array<{ kind: string; n: number }>;
  const tags = (await memory.query(
    "SELECT a AS tag, count(*) AS n FROM memory_entries, jsonb_array_elements_text(anchors) a GROUP BY a ORDER BY n DESC LIMIT 40",
  )) as Array<{ tag: string; n: number }>;
  const byLayer = new Map<string, string[]>();
  for (const k of kinds) {
    const layer = layerOfKind(k.kind);
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), `${k.kind}(${k.n})`]);
  }
  const layerLines = ["prompt", "config", "governance", "knowledge"]
    .filter((l) => byLayer.has(l))
    .map((l) => `${l}: ${byLayer.get(l)!.join(" ")}`);
  return trunc(
    `【记忆空间 · 顶层】\n层视图：\n${layerLines.join("\n")}\n\ntag 词表（${tags.length}+）：\n${tags.map((t) => `${t.tag}(${t.n})`).join(" ")}\n\n深入：memory.index({tag:"<tag>"}) 查条目 / memory.index({id:"<id>"}) 查条目出边`,
  );
}

/** tag → 条目清单（单跳——不附条目出边） */
async function tagView(memory: MemoryLike, tag: string): Promise<string> {
  const entries = await memory.retrieve({ anchors: [tag] });
  if (entries.length === 0) return `【记忆空间 · tag="${tag}"】无可见条目`;
  const lines = entries.slice(0, 20).map((e) => `${e.id} [${e.kind}] ${e.content.replace(/\s+/g, " ").slice(0, 80)}`);
  return trunc(`【记忆空间 · tag="${tag}"】${entries.length} 条：\n${lines.join("\n")}${entries.length > 20 ? `\n…(余 ${entries.length - 20} 条——memory.query 精确提取)` : ""}`);
}

/** id → 条目出边（tag 列表 + 摘要） */
async function idView(memory: MemoryLike, id: string, currentSpace: string): Promise<string> {
  const e = await memory.get(id);
  if (!e) return `【记忆空间 · id="${id}"】不存在`;
  if (!isVisible(e.meta, currentSpace)) return `【记忆空间 · id="${id}"】当前空间（${currentSpace}）不可见`;
  return trunc(`【记忆空间 · ${id}】[${e.kind}]\n摘要: ${e.content.replace(/\s+/g, " ").slice(0, 200)}\ntags: ${e.anchors.join(", ") || "（无）"}\n\n继续：memory.index({tag:"<某 tag>"}) 跳转到关联条目`);
}

export async function buildMemoryIndex(
  opts: { tag?: string; id?: string },
  ctx: { memory: MemoryLike; currentSpace: string },
): Promise<string> {
  if (opts.id) return idView(ctx.memory, opts.id, ctx.currentSpace);
  if (opts.tag) return tagView(ctx.memory, opts.tag);
  return topView(ctx.memory);
}
