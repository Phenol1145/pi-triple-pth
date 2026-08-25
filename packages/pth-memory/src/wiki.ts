/**
 * wiki.ts —— 百科（pth-wiki）写入词表校验（2026-08-15 B5 / 账本 N1b）。
 *
 * 写侧污染防线：worker 面写 kind=pth-wiki 前必须通过词表一致性校验。
 * 系统 seed（scripts/seed/seed-wiki.ts）直写 store 不经此校验。
 *
 * 校验规则（保守 fail-closed）：
 *   1. id 必须是 wiki:<term>；
 *   2. anchors 必须包含该 term（术语即锚点——0.9 约定）；
 *   3. content 必须含「术语：<term>」「域：」「来源：」三要素；
 *   4. 不得与其他 wiki 条目共用同一术语锚点（重复定义）。
 */

import type { MemoryEntry } from "./memory-store-pg.js";

export interface WikiStoreLike {
  listIds(): Promise<string[]>;
  get(id: string): Promise<MemoryEntry | undefined>;
}

export type WikiWriteCheck = { ok: true } | { ok: false; reason: string };

const WIKI_PREFIX = "wiki:";
const WIKI_ANCHOR = "pth-wiki";

function termOf(entry: Pick<MemoryEntry, "id" | "anchors">): string {
  const anchor = (entry.anchors ?? []).find((a) => a !== WIKI_ANCHOR && typeof a === "string" && a.trim() !== "");
  return anchor ?? entry.id.replace(/^wiki:/, "");
}

export async function validateWikiWrite(store: WikiStoreLike, entry: Pick<MemoryEntry, "id" | "kind" | "anchors" | "content">): Promise<WikiWriteCheck> {
  if (entry.kind !== "pth-wiki") return { ok: true };
  const term = termOf(entry).trim();
  if (!term) return { ok: false, reason: "pth-wiki 写入必须带术语锚点（术语即锚点）" };
  if (entry.id !== `${WIKI_PREFIX}${term}`) {
    return { ok: false, reason: `pth-wiki id 必须为 wiki:<term>（got ${entry.id}, term=${term}）` };
  }
  if (!(entry.anchors ?? []).includes(term)) {
    return { ok: false, reason: `pth-wiki anchors 必须包含术语锚点 "${term}"` };
  }
  const content = typeof entry.content === "string" ? entry.content : "";
  if (!content.includes(`术语：${term}`) || !content.includes("域：") || !content.includes("来源：")) {
    return { ok: false, reason: `pth-wiki content 必须含「术语：${term}」「域：」「来源：」（当前 content 不完整）` };
  }
  const ids = await store.listIds();
  for (const id of ids) {
    if (!id.startsWith(WIKI_PREFIX) || id === entry.id) continue;
    const other = await store.get(id);
    if (!other) continue;
    const otherTerm = termOf(other);
    if (otherTerm === term) {
      return { ok: false, reason: `词表矛盾：术语 "${term}" 已被 ${id} 占用——同一术语只允许一个条目` };
    }
  }
  return { ok: true };
}
