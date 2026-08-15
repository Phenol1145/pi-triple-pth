/**
 * skills.ts —— skill 记忆类型的检索面（2026-08-15 B4 Phase 2）。
 *
 * B4-3 已裁 C（两级检索）：
 *   Level 0 = listSkills() 清单（id + 三要素摘要，不加载全文）；
 *   Level 1 = getSkill(id) 全文（按需加载）。
 * 数据源 = memory_entries 中 kind 以 "skill:" 为前缀的条目。
 */

import type { MemoryEntry } from "./memory-store-pg.js";

export interface SkillStoreLike {
  listIds(): Promise<string[]>;
  get(id: string): Promise<MemoryEntry | undefined>;
}

export interface SkillSummary {
  id: string;
  anchor: string;
  whenToUse: string;
  effect: string;
  status: string;
}

const SKILL_KIND_PREFIX = "skill:";

function fieldOf(content: string, label: string): string {
  const re = new RegExp(`【${label}】([^\\n]*)`);
  return content.match(re)?.[1]?.trim() ?? "";
}

export function parseSkillSummary(entry: Pick<MemoryEntry, "id" | "kind" | "content" | "status">): SkillSummary {
  const content = typeof entry.content === "string" ? entry.content : "";
  return {
    id: entry.id,
    anchor: fieldOf(content, "场景锚点"),
    whenToUse: fieldOf(content, "何时用"),
    effect: fieldOf(content, "效果"),
    status: entry.status,
  };
}

/** Level 0：所有 skill:* 条目的三要素清单（只读官方/draft 均可——调用方决定过滤） */
export async function listSkills(store: SkillStoreLike): Promise<SkillSummary[]> {
  const ids = await store.listIds();
  const skillIds = ids.filter((id) => id.startsWith(SKILL_KIND_PREFIX));
  const out: SkillSummary[] = [];
  for (const id of skillIds) {
    const entry = await store.get(id);
    if (entry) out.push(parseSkillSummary(entry));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Level 1：按 id 取全文；自动补 skill: 前缀。 */
export async function getSkill(store: SkillStoreLike, idOrName: string): Promise<MemoryEntry | undefined> {
  const id = idOrName.startsWith(SKILL_KIND_PREFIX) ? idOrName : `${SKILL_KIND_PREFIX}${idOrName}`;
  return store.get(id);
}
