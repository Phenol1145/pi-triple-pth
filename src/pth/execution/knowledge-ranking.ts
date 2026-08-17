/**
 * execution/knowledge-ranking.ts — F4 AB-07：query-sensitive knowledge ranking。
 *
 * 纯函数模块：retrieve 后的统一排序（broker search / knowledge-context / pilot evaluator 共用）。
 * score = domainRelevance * 1000 + queryTokenHits；
 *  - domainRelevance = entry.anchors ∩ (domains ∪ domainAncestors) 命中数；
 *  - queryTokenHits = queryText 空白分词后对 content+anchors 大小写不敏感子串命中数
 *    （无 queryText 时 queryTokenHits=0）；
 *  - 降序 score → id 升序 tie-break。
 */

export interface RankableKnowledgeEntry {
  id: string;
  anchors?: readonly string[];
  content: string;
}

export interface RankKnowledgeEntriesOptions {
  queryText?: string;
  domains?: readonly string[];
  domainAncestors?: readonly string[];
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tokenize(queryText: string | undefined): string[] {
  const query = queryText?.trim() ?? "";
  if (query === "") return [];
  return query.split(/\s+/).map((token) => token.toLowerCase());
}

function containsToken(content: string, anchors: readonly string[] | undefined, token: string): boolean {
  if (content.toLowerCase().includes(token)) return true;
  return (anchors ?? []).some((anchor) => anchor.toLowerCase().includes(token));
}

/**
 * queryText 大小写不敏感子串过滤：content 或 anchors 命中任一空白分词；
 * 无 queryText / 无词命中 → 返回全部（保守不误杀——中文整句无空白分词时不能误杀）。
 */
export function filterKnowledgeEntriesByQueryText<T extends RankableKnowledgeEntry>(
  entries: readonly T[],
  queryText: string | undefined,
): T[] {
  const query = queryText?.trim() ?? "";
  if (query === "") return [...entries];

  const tokens = query.split(/\s+/).map((t) => t.toLowerCase());
  if (tokens.length === 0) return [...entries];

  const matched = entries.filter((entry) => {
    const content = entry.content.toLowerCase();
    const anchors = (entry.anchors ?? []).map((a) => a.toLowerCase());
    return tokens.some((token) => content.includes(token) || anchors.some((a) => a.includes(token)));
  });

  return matched.length > 0 ? matched : [...entries];
}

export function rankKnowledgeEntries<T extends RankableKnowledgeEntry>(
  entries: readonly T[],
  opts: RankKnowledgeEntriesOptions,
): T[] {
  const hitSet = new Set<string>([...(opts.domains ?? []), ...(opts.domainAncestors ?? [])]);
  const tokens = tokenize(opts.queryText);

  return entries
    .map((entry) => {
      const domainRelevance = (entry.anchors ?? []).reduce(
        (n, anchor) => n + (hitSet.has(anchor) ? 1 : 0),
        0,
      );
      const queryTokenHits = tokens.reduce(
        (n, token) => n + (containsToken(entry.content, entry.anchors, token) ? 1 : 0),
        0,
      );
      const score = domainRelevance * 1000 + queryTokenHits;
      return { entry, score };
    })
    .sort((a, b) => (b.score - a.score) || compareIds(a.entry.id, b.entry.id))
    .map(({ entry }) => entry);
}
