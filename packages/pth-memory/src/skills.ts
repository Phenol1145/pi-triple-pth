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

/** B4 Phase 3：memory-keeper 维护面的 store 能力（需要 force 通道的完整 store） */
export interface SkillMaintenanceStore extends SkillStoreLike {
  write(entry: MemoryEntry, opts?: { force?: boolean }): Promise<void>;
  update(id: string, patch: Partial<MemoryEntry>, opts?: { force?: boolean }): Promise<void>;
}

export interface SkillMaintainResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/** B4 Phase 4：SKILL.md → skill 条目映射（0.13 转化落点）
 *
 *  pi SKILL.md 允许的前置元数据（name/description）不要求存在；映射以正文为准：
 *    name        ← 标题 `# skill:<name>（SOP…）`（无标题则必须由调用方显式传 name）
 *    【场景锚点】  ← SKILL.md 的「场景锚点」段
 *    【何时用】    ← 「何时用」段（description 可作为何时用之一）
 *    【效果】      ← 「效果」段
 *    Procedure    ← 有序步骤，每步 `（代价：…）`；缺代价按 unknown 记
 *    Pitfalls     ← 无序列表
 *    Verification ← 无序列表
 *  四段缺一 → 解析失败（N4 pipeline 写该格式时必须完整）。
 */
export type SkillMarkdownParseResult =
  | { ok: true; name: string; seed: { id: string; anchor: string; whenToUse: string; effect: string; procedure: { step: string; cost: string }[]; pitfalls: string[]; verification: string[] } }
  | { ok: false; error: string };

export function parseSkillMarkdown(md: string, explicitName?: string): SkillMarkdownParseResult {
  const text = String(md ?? "");
  const titleMatch = text.match(/^#\s*skill:([a-zA-Z0-9][a-zA-Z0-9._-]*)/m);
  const name = explicitName?.trim() || titleMatch?.[1];
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
    return { ok: false, error: "skill 名称缺失或非法（标题 `# skill:<name>` 或显式 name）" };
  }
  const anchor = text.match(/【场景锚点】([^\n]*)/)?.[1]?.trim() ?? "";
  const whenToUse = text.match(/【何时用】([^\n]*)/)?.[1]?.trim() ?? "";
  const effect = text.match(/【效果】([^\n]*)/)?.[1]?.trim() ?? "";
  if (!anchor || !whenToUse || !effect) {
    return { ok: false, error: "四段式不完整：场景锚点/何时用/效果 缺一不可" };
  }
  const procedure: { step: string; cost: string }[] = [];
  const procBody = text.split(/##\s*Procedure/i)[1]?.split(/^##\s/m)[0] ?? "";
  for (const line of procBody.split("\n")) {
    const m = line.match(/^\s*\d+\.\s+(.+?)(?:\s*（代价：([^）]*)）)?\s*$/);
    if (m?.[1]) procedure.push({ step: m[1].trim(), cost: m[2]?.trim() || "unknown" });
  }
  const listBody = (section: string): string[] => {
    const body = text.split(new RegExp(`##\\s*${section}`, "i"))[1]?.split(/^##\s/m)[0] ?? "";
    return body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  };
  const pitfalls = listBody("Pitfalls");
  const verification = listBody("Verification");
  if (procedure.length === 0 || pitfalls.length === 0 || verification.length === 0) {
    return { ok: false, error: "四段式不完整：Procedure/Pitfalls/Verification 至少各一条" };
  }
  return { ok: true, name, seed: { id: name, anchor, whenToUse, effect, procedure, pitfalls, verification } };
}

export interface SkillMaintainWriteInput {
  /** 不带前缀的 skill 名 */
  name: string;
  content: string;
  anchors?: string[];
  /** 显式覆写（force）；缺省只允许新条目 */
  force?: boolean;
  audit?: string;
}

/** 维护面写 skill：新条目直写；已存在必须显式 force（写后冻结的修订审计）。 */
export async function maintainSkillWrite(store: SkillMaintenanceStore, input: SkillMaintainWriteInput): Promise<SkillMaintainResult> {
  const name = String(input.name ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
    return { ok: false, error: `invalid skill name: ${name}` };
  }
  if (typeof input.content !== "string" || input.content.trim() === "") {
    return { ok: false, error: "skill content required" };
  }
  const id = `${SKILL_KIND_PREFIX}${name}`;
  const existing = await store.get(id);
  if (existing && !input.force) {
    return { ok: false, error: `skill ${id} 已存在且不可变——修订需显式 force（audit 留痕）或先 archive 再写新条目` };
  }
  const now = Date.now();
  await store.write({
    id,
    kind: id,
    anchors: input.anchors && input.anchors.length > 0 ? input.anchors : [name],
    content: input.content,
    status: "official",
    meta: {
      ...(existing?.meta ?? {}),
      maintainedAt: now,
      maintainedBy: "memory-keeper",
      revision: (Number(existing?.meta?.revision ?? 0) || 0) + 1,
      ...(input.audit ? { auditNote: input.audit } : {}),
    },
  }, { force: true });
  return { ok: true, id };
}

/** 维护面归档 skill（修订流：archive 旧条目 + 写新条目）。 */
export async function maintainSkillArchive(store: SkillMaintenanceStore, idOrName: string, audit?: string): Promise<SkillMaintainResult> {
  const id = idOrName.startsWith(SKILL_KIND_PREFIX) ? idOrName : `${SKILL_KIND_PREFIX}${idOrName}`;
  const existing = await store.get(id);
  if (!existing) return { ok: false, error: `skill not found: ${id}` };
  await store.update(id, {
    status: "archived",
    meta: { ...(existing.meta ?? {}), archivedAt: Date.now(), archivedBy: "memory-keeper", ...(audit ? { auditNote: audit } : {}) },
  }, { force: true });
  return { ok: true, id };
}
