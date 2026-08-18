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

/** N28 T4：查询词命中数公共实现（rankKnowledgeEntries 复用同一实现，不维护第二套）。 */
export function knowledgeQueryTokenHits(entry: RankableKnowledgeEntry, queryText: string | undefined): number {
  return tokenize(queryText).reduce(
    (count, token) => count + (containsToken(entry.content, entry.anchors, token) ? 1 : 0),
    0,
  );
}

function normalizeQueryText(queryText: string | undefined): string {
  return (queryText ?? "").trim().toLocaleLowerCase();
}

/**
 * 归一化查询-条目相关性（R5 fail-closed）：
 *  - ASCII/数字词（如 Java、LLVM、2026-08）按 content+anchors 子串匹配；
 *  - CJK 锚点（如「类型检查」「离子电导率」）按「anchor 出现在 query 中」匹配——
 *    中文无空白分词时不会把整句当一个 token 导致误杀。
 * 不命中任何 anchor/content 的条目视为无关条目。
 */
function entryMatchesQuery(entry: RankableKnowledgeEntry, query: string): boolean {
  const content = entry.content.toLocaleLowerCase();
  const anchors = (entry.anchors ?? []).map((a) => a.toLocaleLowerCase());

  const asciiWords = query.match(/[a-z0-9][a-z0-9_+#.-]*/g) ?? [];
  if (asciiWords.some((word) => content.includes(word) || anchors.some((a) => a.includes(word)))) {
    return true;
  }

  return anchors.some((anchor) => {
    const trimmed = anchor.trim();
    return /[\u3400-\u9fff]/.test(trimmed) && trimmed.length >= 2 && query.includes(trimmed);
  });
}

export interface FilterKnowledgeEntriesOptions {
  /** strict=true：零命中 fail-closed 返回空（生产 Context 与评测同走）；缺省 false 保持旧回退。 */
  strict?: boolean;
}

/**
 * queryText 相关性过滤。query 为空 → 返回全部（无 queryText 不误杀）；
 * 无任何条目命中 → strict=true 返回空，strict=false 回退全部（旧语义）。
 */
export function filterKnowledgeEntriesByQueryText<T extends RankableKnowledgeEntry>(
  entries: readonly T[],
  queryText: string | undefined,
  options: FilterKnowledgeEntriesOptions = {},
): T[] {
  const query = normalizeQueryText(queryText);
  if (query === "") return [...entries];

  const matched = entries.filter((entry) => entryMatchesQuery(entry, query));

  if (matched.length > 0) return matched;
  return options.strict ? [] : [...entries];
}

export function rankKnowledgeEntries<T extends RankableKnowledgeEntry>(
  entries: readonly T[],
  opts: RankKnowledgeEntriesOptions,
): T[] {
  const hitSet = new Set<string>([...(opts.domains ?? []), ...(opts.domainAncestors ?? [])]);

  return entries
    .map((entry) => {
      const domainRelevance = (entry.anchors ?? []).reduce(
        (n, anchor) => n + (hitSet.has(anchor) ? 1 : 0),
        0,
      );
      const queryTokenHits = knowledgeQueryTokenHits(entry, opts.queryText);
      const score = domainRelevance * 1000 + queryTokenHits;
      return { entry, score };
    })
    .sort((a, b) => (b.score - a.score) || compareIds(a.entry.id, b.entry.id))
    .map(({ entry }) => entry);
}
