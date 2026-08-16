/**
 * memory-scope.ts —— memoryScope="own" 的角色记忆域过滤（模块优化 ⑤）。
 *
 * own 角色写侧已自动注入 role:<role> anchor；本模块提供读侧过滤的单一实现：
 * get/retrieve 按锚点过滤；query 要求投影 anchors 列并同样过滤（fail-closed）。
 */

export function roleAnchorOf(role: string): string {
  return `role:${role}`;
}

export function hasRoleAnchor(role: string, entry: { anchors?: unknown } | null | undefined): boolean {
  const anchors = entry?.anchors;
  return Array.isArray(anchors) && anchors.includes(roleAnchorOf(role));
}

export function filterOwnEntries<T extends { anchors?: unknown }>(role: string, entries: T[]): T[] {
  return entries.filter((e) => hasRoleAnchor(role, e));
}

export function requireAnchorRows(rows: Array<Record<string, unknown> | null | undefined>): Array<Record<string, unknown>> {
  if (rows.some((r) => !r || typeof r !== "object" || !("anchors" in r))) {
    throw new Error("memory.query: memoryScope=own 查询必须包含 anchors 列（角色域过滤依据）——请 SELECT ..., anchors FROM memory_entries ...");
  }
  return rows as Array<Record<string, unknown>>;
}

export function filterOwnRows<T extends { anchors?: unknown }>(role: string, rows: T[]): T[] {
  return filterOwnEntries(role, rows);
}
