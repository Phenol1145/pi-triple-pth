/**
 * catalog/pilot-evaluator.ts — N23 K5 评测批：离线可复现评测器。
 *
 * 与 K3 knowledge-context 同规则：
 *  - domain 解析：createDisciplineResolver(catalog).resolve({title:text.slice(0,80), text, tags:[], explicitDomains:[]});
 *  - knowledge 检索：anchors = resolver.matches 的 domainIds；
 *  - relevance = entry.anchors ∩ (domains ∪ catalog.ancestors(domains))；
 *  - 排序：relevance 降序 → id 升序 → top5。
 * 指标计算完全确定性（无随机、无时间、无外部 I/O）。
 */

import type { DisciplineCatalogSnapshot } from "./discipline-catalog.js";
import { createDisciplineResolver } from "./discipline-resolver.js";
import type { PilotKnowledgeEntry } from "./data/pilot-knowledge.js";
import type { PilotEvalQuery } from "./data/pilot-eval-queries.js";
import type { PilotKnowledgeSource } from "./data/pilot-source-registry.js";

export interface PilotEvalMetrics {
  domainRecallAt3: number; // 期望 domain 出现在 resolver.matches 前 3
  domainTop1: number; // primaryDomain = 期望 domain 占比
  knowledgeRecallAt5: number; // 期望 entryId 出现在 top-5 检索结果
  evidenceCoverage: number; // authoritative 查询命中的条目 100% 有 evidence 的占比
  queryCount: number;
  details: Array<{ queryId: string; domain: string; pass: boolean; reason?: string }>;
}

export interface PilotEvalDetail {
  queryId: string;
  domain: string;
  pass: boolean;
  reason?: string;
}

const DOMAIN_TOP_N = 3;
const KNOWLEDGE_TOP_N = 5;
/** 与 K3 knowledge-context 的 RELEVANCE_ANCHOR_CAP 保持一致。 */
const RELEVANCE_ANCHOR_CAP = 8;

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 按 K3 provider 同规则对 knowledge 排序并返回 top-5。
 * - 检索面：entry.anchors 任一命中 domains（memory.retrieve 并集语义）；
 * - 命中面：domains + catalog.ancestors(domains)；
 * - relevance：entry.anchors 前 8 个中落在命中面的数量；
 * - 排序：relevance 降序 → id 升序（与 K3 相同）。
 */
export function rankKnowledgeForDomains(
  catalog: DisciplineCatalogSnapshot,
  knowledge: readonly PilotKnowledgeEntry[],
  domains: readonly string[],
): PilotKnowledgeEntry[] {
  const hitSet = new Set<string>(domains);
  for (const domain of domains) {
    for (const ancestor of catalog.ancestors(domain)) {
      hitSet.add(ancestor);
    }
  }

  return knowledge
    .filter((entry) => entry.anchors.some((anchor) => domains.includes(anchor)))
    .map((entry) => ({
      entry,
      relevance: entry.anchors
        .slice(0, RELEVANCE_ANCHOR_CAP)
        .reduce((n, anchor) => n + (hitSet.has(anchor) ? 1 : 0), 0),
    }))
    .sort((a, b) => (b.relevance - a.relevance) || compareIds(a.entry.id, b.entry.id))
    .map(({ entry }) => entry)
    .slice(0, KNOWLEDGE_TOP_N);
}

export interface PilotQueryEvalResult {
  detail: PilotEvalDetail;
  /** 期望 domain 出现在 resolver.matches 前 3 */
  domainInTop3: boolean;
  /** primaryDomain = 期望 domain */
  domainTop1: boolean;
  /** 期望 entryId 出现在 top-5 检索结果 */
  knowledgePass: boolean;
  /** authoritative 查询 top-5 命中条目的 evidence 全部可溯源 */
  evidencePass: boolean;
  /** 该查询是否计入 evidenceCoverage 分母 */
  authoritative: boolean;
}

export function evaluatePilotQuery(input: {
  catalog: DisciplineCatalogSnapshot;
  knowledge: readonly PilotKnowledgeEntry[];
  query: PilotEvalQuery;
  sourceIds: ReadonlySet<string>;
}): PilotQueryEvalResult {
  const resolver = createDisciplineResolver(input.catalog);
  const resolved = resolver.resolve({
    title: input.query.text.slice(0, 80),
    text: input.query.text,
    tags: [],
    explicitDomains: [],
  });

  const matchDomainIds = resolved.ok
    ? resolved.binding.matches.map((match) => match.domainId)
    : [];
  const domainInTop3 = matchDomainIds.slice(0, DOMAIN_TOP_N).includes(input.query.domain);
  const domainTop1 = resolved.ok && resolved.binding.primaryDomain === input.query.domain;

  const top5 = rankKnowledgeForDomains(input.catalog, input.knowledge, matchDomainIds);
  const top5Ids = top5.map((entry) => entry.id);
  const hitExpected = input.query.expectedEntryIds.filter((id) => top5Ids.includes(id));
  const knowledgePass = hitExpected.length > 0;

  let evidencePass = true;
  if (input.query.authoritative) {
    // authoritative 查询：top-5 命中条目的 evidence[].sourceId 必须全部存在于 sources。
    evidencePass = top5.every((entry) =>
      entry.evidence.every((evidence) => input.sourceIds.has(evidence.sourceId)),
    );
  }

  const pass = domainInTop3 && knowledgePass && evidencePass;
  let reason: string | undefined;
  if (!pass) {
    const reasons: string[] = [];
    if (!resolved.ok) {
      reasons.push(`resolver error: ${resolved.error}`);
    } else if (!domainInTop3) {
      reasons.push(
        `expected domain ${input.query.domain} not in top3 matches (got ${matchDomainIds.slice(0, DOMAIN_TOP_N).join(", ") || "none"})`,
      );
    }
    if (!knowledgePass) {
      reasons.push(
        `expected entries [${input.query.expectedEntryIds.join(", ")}] not in top5 [${top5Ids.join(", ") || "none"}]`,
      );
    }
    if (input.query.authoritative && !evidencePass) {
      const missing = top5
        .flatMap((entry) =>
          entry.evidence
            .filter((evidence) => !input.sourceIds.has(evidence.sourceId))
            .map((evidence) => `${entry.id}:${evidence.sourceId}`),
        );
      reasons.push(`evidence sourceId missing from sources: ${missing.join(", ")}`);
    }
    reason = reasons.join("; ");
  }

  return {
    detail: { queryId: input.query.id, domain: input.query.domain, pass, reason },
    domainInTop3,
    domainTop1,
    knowledgePass,
    evidencePass,
    authoritative: input.query.authoritative,
  };
}

export function runPilotEval(input: {
  catalog: DisciplineCatalogSnapshot;
  knowledge: PilotKnowledgeEntry[];
  queries: PilotEvalQuery[];
  sources: PilotKnowledgeSource[];
}): PilotEvalMetrics {
  const sourceIds = new Set(input.sources.map((source) => source.id));

  let domainTop3Hits = 0;
  let domainTop1Hits = 0;
  let knowledgeHits = 0;
  let evidenceHits = 0;
  let authoritativeCount = 0;
  const details: PilotEvalDetail[] = [];

  for (const query of input.queries) {
    const result = evaluatePilotQuery({
      catalog: input.catalog,
      knowledge: input.knowledge,
      query,
      sourceIds,
    });

    if (result.domainInTop3) domainTop3Hits += 1;
    if (result.domainTop1) domainTop1Hits += 1;
    if (result.knowledgePass) knowledgeHits += 1;
    if (result.authoritative && result.evidencePass) evidenceHits += 1;
    if (result.authoritative) authoritativeCount += 1;

    details.push(result.detail);
  }

  const queryCount = input.queries.length;
  return {
    domainRecallAt3: queryCount === 0 ? 0 : domainTop3Hits / queryCount,
    domainTop1: queryCount === 0 ? 0 : domainTop1Hits / queryCount,
    knowledgeRecallAt5: queryCount === 0 ? 0 : knowledgeHits / queryCount,
    evidenceCoverage: authoritativeCount === 0 ? 1 : evidenceHits / authoritativeCount,
    queryCount,
    details,
  };
}
