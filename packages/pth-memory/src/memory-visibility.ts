/**
 * memory-visibility —— 记忆可见性（空间作用域——ASP v2 用户裁决）。
 *
 * 规则：
 *   - 写入必须显式声明 visibility（public/private——缺省拒绝）
 *   - 声明方式：entry.meta.visibility = "public"\|"private"；space 分量由系统盖章
 *     （= 写入时所在空间——worker 不可自定，防声明更大作用域提权）
 *   - public = 本空间 + 后代空间可见；private = 仅本空间
 *   - 父空间看不到子空间条目（可见性沿空间树向下流动）
 *   - 存量无声明条目：视为 meta+public（向后兼容——memory-keeper 迁移前过渡）
 *
 * 存储：entry.meta.spaceScope = { space, visibility }（不加列——meta jsonb 足够）。
 */

/** 空间查询注入接口（2026-08-15 拆分：pth-memory 不 import PTH core，由装配层注入 spaceRegistry.get） */
export interface SpaceLookup {
  get(id: string): { parent?: string } | undefined;
}

let spaceLookup: SpaceLookup | undefined;

/** 装配层注入空间查询（PTH core 启动时 setSpaceLookup(spaceRegistry.get.bind(spaceRegistry))） */
export function setSpaceLookup(lookup: SpaceLookup): void {
  spaceLookup = lookup;
}

export type Visibility = "public" | "private";

export interface SpaceScope {
  space: string;
  visibility: Visibility;
}

/** 条目 meta 中的空间作用域读取（存量条目 → 默认 meta+public） */
export function scopeOf(meta: Record<string, unknown> | undefined): SpaceScope {
  const s = meta?.["spaceScope"] as { space?: string; visibility?: string } | undefined;
  if (s && typeof s.space === "string" && (s.visibility === "public" || s.visibility === "private")) {
    return { space: s.space, visibility: s.visibility };
  }
  return { space: "meta", visibility: "public" };   // 存量兼容（迁移前）
}

/** space 是否 ancestorSpace 的后代或自身（沿 parent 链上溯） */
export function isDescendantOrSelf(space: string, ancestorSpace: string): boolean {
  let cur: string | undefined = space;
  for (let i = 0; i < 16 && cur; i++) {   // 深度保护（防坏 parent 环）
    if (cur === ancestorSpace) return true;
    cur = spaceLookup?.get(cur)?.parent;
  }
  return false;
}

/** H5：可见性过滤单一入口（memory.query/retrieve/get 与 recall 面共用） */
export function filterVisibleEntries<T extends { meta?: unknown }>(entries: T[], currentSpace?: string): T[] {
  if (!currentSpace) return entries;   // 非会话态——过渡兼容
  return entries.filter((e) => isVisible(e.meta as Record<string, unknown> | undefined, currentSpace));
}

/** H5：SQL 行过滤（rows 已由调用方保证含 meta 列） */
export function filterVisibleRows<T extends { meta?: unknown }>(rows: T[], currentSpace?: string): T[] {
  return filterVisibleEntries(rows, currentSpace);
}

/** H3/H5：fail-closed 元数据列断言（缺 meta 无法判定可见性——拒绝而非默认公开） */
export function requireMetaRows(rows: Array<Record<string, unknown> | null | undefined>): Array<Record<string, unknown>> {
  if (rows.some((r) => !r || typeof r !== "object" || !("meta" in r))) {
    throw new Error("memory.query: 会话空间下查询必须包含 meta 列（可见性过滤依据）——请 SELECT ..., meta FROM memory_entries ...");
  }
  return rows as Array<Record<string, unknown>>;
}

/** 条目对当前空间是否可见 */
export function isVisible(meta: Record<string, unknown> | undefined, currentSpace: string): boolean {
  const scope = scopeOf(meta);
  if (scope.visibility === "private") return scope.space === currentSpace;
  return isDescendantOrSelf(currentSpace, scope.space);
}

/** 写入校验：visibility 必须显式声明（用户裁决——无默认）；space 由系统盖章 */
export function checkVisibilityDeclaration(meta: Record<string, unknown> | undefined): { ok: true } | { ok: false; reason: string } {
  const v = meta?.["visibility"];
  if (v !== "public" && v !== "private") {
    return { ok: false, reason: 'memory.save: 必须显式声明可见性——meta.visibility: "public"（本空间+后代可见）| "private"（仅本空间）——space 由系统按当前空间盖章' };
  }
  return { ok: true };
}

/** 系统盖章：写入时把声明落到 spaceScope（space=当前空间） */
export function stampScope(meta: Record<string, unknown>, currentSpace: string): Record<string, unknown> {
  const { visibility, ...rest } = meta;
  return { ...rest, spaceScope: { space: currentSpace, visibility: visibility as Visibility } };
}
