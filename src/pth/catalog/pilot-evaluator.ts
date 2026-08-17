/**
 * catalog/pilot-evaluator.ts — N23 K5 + F4 评测批：离线可复现评测器。
 *
 * F4（AB-07/AB-08/6.4/6.5/6.6）：
 *  - 检索统一复用 execution/knowledge-ranking.ts 的 rankKnowledgeEntries（不允许自带排序）；
 *  - authoritative 判定 fail-closed：空 top-5 / 空 evidence / 缺 sourceId / snapshot 漂移一律 fail；
 *  - 新增 hardNegativePassRate / multiDomainResolution / distractorTop3Rate；
 *  - 标准 60 题继续使用 domainRecallAt3 / domainTop1 / knowledgeRecallAt5 / evidenceCoverage 阈值语义。
 * 指标计算完全确定性（无随机、无时间、无外部 I/O）。
 */

import type { DisciplineCatalogSnapshot } from "./discipline-catalog.js";
import { createDisciplineResolver } from "./discipline-resolver.js";
import type { PilotKnowledgeEntry } from "./data/pilot-knowledge.js";
import type { PilotEvalQuery } from "./data/pilot-eval-queries.js";
import type { PilotKnowledgeSource } from "./data/pilot-source-registry.js";
import { PILOT_SOURCE_SNAPSHOTS, artifactHashOf } from "./data/pilot-source-snapshots.js";
import { filterKnowledgeEntriesByQueryText, rankKnowledgeEntries } from "../execution/index.js";

export interface PilotEvalMetrics {
  queryCount: number;
  standardQueryCount: number;
  /** 标准题（60）：期望 domain 出现在 resolver.matches 前 3 */
  domainRecallAt3: number;
  /** 标准题（60）：primaryDomain = 期望 domain 占比 */
  domainTop1: number;
  /** 标准题（60）：期望 entryId 出现在 top-5 检索结果 */
  knowledgeRecallAt5: number;
  /** 标准题（60）：authoritative 查询命中条目 evidence 全部可溯源且非空 */
  evidenceCoverage: number;
  /** hard negative/no-answer：top5 为空占比（目标 1.0） */
  hardNegativePassRate: number;
  /** 多域组合：resolver 前 3 包含全部 expectedDomains 占比（目标 1.0） */
  multiDomainResolution: number;
  /** 混淆题：primaryDomain=目标域或目标域在 top3 占比（目标 ≥0.9） */
  distractorTop3Rate: number;
  domainQueries: number;
  knowledgeQueries: number;
  authoritativeQueries: number;
  hardNegativeQueries: number;
  multiDomainQueries: number;
  distractorQueries: number;
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

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueDomainAncestors(catalog: DisciplineCatalogSnapshot, domains: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const domain of domains) {
    for (const ancestor of catalog.ancestors(domain)) {
      if (!seen.has(ancestor)) {
        seen.add(ancestor);
        out.push(ancestor);
      }
    }
  }
  return out;
}

export interface PilotSourceSnapshotIntegrity {
  artifactHash: string;
  snapshotContent: string;
}

/** 离线/live 通用 evidence source 校验：存在 + snapshot 内容与 artifactHash 一致。 */
export function isEvidenceSourceOk(
  sourceId: string,
  sourceIds: ReadonlySet<string>,
  sourceSnapshots?: ReadonlyMap<string, PilotSourceSnapshotIntegrity>,
): boolean {
  if (!sourceIds.has(sourceId)) return false;
  const snapshot = sourceSnapshots?.get(sourceId);
  if (snapshot) {
    return artifactHashOf(snapshot.snapshotContent) === snapshot.artifactHash;
  }
  return true;
}

export interface PilotQueryEvalResult {
  detail: PilotEvalDetail;
  /** 期望 domain 出现在 resolver.matches 前 3 */
  domainInTop3: boolean;
  /** primaryDomain = 期望 domain */
  domainTop1: boolean;
  /** 期望 entryId 出现在 top-5 检索结果（或 hard negative 的 top5 为空） */
  knowledgePass: boolean;
  /** authoritative 查询 top-5 命中条目的 evidence 全部可溯源且非空 */
  evidencePass: boolean;
  /** 该查询是否计入 evidenceCoverage 分母 */
  authoritative: boolean;
  /** 多域组合：resolver 前 3 包含全部 expectedDomains */
  multiDomainPass?: boolean;
  /** 混淆题：primaryDomain=目标域或目标域在 top3 */
  distractorPass?: boolean;
}

export function evaluatePilotQuery(input: {
  catalog: DisciplineCatalogSnapshot;
  knowledge: readonly PilotKnowledgeEntry[];
  query: PilotEvalQuery;
  sourceIds: ReadonlySet<string>;
  sourceSnapshots?: ReadonlyMap<string, PilotSourceSnapshotIntegrity>;
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

  // 检索面与 broker search 同一管线：anchors 并集 retrieve → queryText 过滤 → rankKnowledgeEntries → top5。
  const retrieved = matchDomainIds.length > 0
    ? input.knowledge.filter((entry) => entry.anchors.some((anchor) => matchDomainIds.includes(anchor)))
    : [];
  const filtered = filterKnowledgeEntriesByQueryText(retrieved, input.query.text);
  const domainAncestors = uniqueDomainAncestors(input.catalog, matchDomainIds);
  const ranked = rankKnowledgeEntries(filtered, {
    queryText: input.query.text,
    domains: matchDomainIds,
    domainAncestors,
  });
  const top5 = ranked.slice(0, KNOWLEDGE_TOP_N);
  const top5Ids = top5.map((entry) => entry.id);

  let knowledgePass: boolean;
  if (input.query.expectNoKnowledge) {
    knowledgePass = top5.length === 0;
  } else if (input.query.expectedEntryIds.length > 0) {
    const hitExpected = input.query.expectedEntryIds.filter((id) => top5Ids.includes(id));
    knowledgePass = hitExpected.length > 0;
  } else {
    // 多域/混淆题不断言 knowledge
    knowledgePass = true;
  }

  let evidencePass = true;
  if (input.query.authoritative) {
    evidencePass = top5.length > 0
      && top5.every((entry) => entry.evidence.length > 0)
      && top5.every((entry) =>
        entry.evidence.every((evidence) => isEvidenceSourceOk(evidence.sourceId, input.sourceIds, input.sourceSnapshots)),
      );
  }

  const multiDomainPass = input.query.expectedDomains && input.query.expectedDomains.length > 0
    ? input.query.expectedDomains.every((domain) => matchDomainIds.slice(0, DOMAIN_TOP_N).includes(domain))
    : undefined;

  const distractorPass = input.query.distractorDomain
    ? domainTop1 || domainInTop3
    : undefined;

  let pass: boolean;
  if (input.query.expectNoKnowledge) {
    pass = knowledgePass;
  } else if (input.query.expectedDomains && input.query.expectedDomains.length > 0) {
    pass = multiDomainPass === true;
  } else if (input.query.distractorDomain) {
    pass = distractorPass === true;
  } else {
    pass = domainInTop3 && knowledgePass && (!input.query.authoritative || evidencePass);
  }

  let reason: string | undefined;
  if (!pass) {
    const reasons: string[] = [];
    if (!resolved.ok) {
      reasons.push(`resolver error: ${resolved.error}`);
    } else if (input.query.expectNoKnowledge) {
      if (!knowledgePass) {
        reasons.push(`hard negative expected empty top5 but got [${top5Ids.join(", ")}]`);
      }
    } else if (input.query.expectedDomains && input.query.expectedDomains.length > 0) {
      if (!multiDomainPass) {
        reasons.push(
          `expected domains [${input.query.expectedDomains.join(", ")}] not all in top3 (got ${matchDomainIds.slice(0, DOMAIN_TOP_N).join(", ") || "none"})`,
        );
      }
    } else if (input.query.distractorDomain) {
      if (!distractorPass) {
        reasons.push(
          `expected primaryDomain=${input.query.domain} or target in top3 (got primary=${resolved.binding.primaryDomain ?? "none"}, top3=${matchDomainIds.slice(0, DOMAIN_TOP_N).join(", ") || "none"})`,
        );
      }
    } else {
      if (!domainInTop3) {
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
        if (top5.length === 0) {
          reasons.push("authoritative query got empty top5");
        }
        const emptyEvidence = top5.filter((entry) => entry.evidence.length === 0).map((entry) => entry.id);
        if (emptyEvidence.length > 0) {
          reasons.push(`empty evidence in entries: ${emptyEvidence.join(", ")}`);
        }
        const missing = top5
          .flatMap((entry) =>
            entry.evidence
              .filter((evidence) => !isEvidenceSourceOk(evidence.sourceId, input.sourceIds, input.sourceSnapshots))
              .map((evidence) => `${entry.id}:${evidence.sourceId}`),
          );
        if (missing.length > 0) {
          reasons.push(`evidence sourceId missing from sources: ${missing.join(", ")}`);
        }
        const drift = top5
          .flatMap((entry) =>
            entry.evidence
              .filter((evidence) => {
                if (!input.sourceIds.has(evidence.sourceId)) return false;
                const snapshot = input.sourceSnapshots?.get(evidence.sourceId);
                return !!snapshot && artifactHashOf(snapshot.snapshotContent) !== snapshot.artifactHash;
              })
              .map((evidence) => `${entry.id}:${evidence.sourceId}`),
          );
        if (drift.length > 0) {
          reasons.push(`evidence source snapshot drift: ${drift.join(", ")}`);
        }
      }
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
    multiDomainPass,
    distractorPass,
  };
}

/** 把 sources + snapshots 组成 evidence 校验索引（离线）。 */
export function buildSourceSnapshotIndex(sources: readonly PilotKnowledgeSource[]): ReadonlyMap<string, PilotSourceSnapshotIntegrity> {
  const snapshotBySource = new Map(PILOT_SOURCE_SNAPSHOTS.map((snapshot) => [snapshot.sourceId, snapshot]));
  const out = new Map<string, PilotSourceSnapshotIntegrity>();
  for (const source of sources) {
    const snapshot = snapshotBySource.get(source.id);
    out.set(source.id, {
      artifactHash: source.artifactHash,
      snapshotContent: snapshot?.snapshotContent ?? "",
    });
  }
  return out;
}

/** 把逐题结果按题型分区聚合成指标（离线/live 共用）。 */
export function aggregatePilotMetrics(
  queries: readonly PilotEvalQuery[],
  results: readonly PilotQueryEvalResult[],
): PilotEvalMetrics {
  const standardQueries = queries.filter((q) => !q.expectNoKnowledge && !q.expectedDomains && !q.distractorDomain);
  const hardNegativeQueries = queries.filter((q) => q.expectNoKnowledge);
  const multiDomainQueries = queries.filter((q) => !!q.expectedDomains && q.expectedDomains.length > 0);
  const distractorQueries = queries.filter((q) => !!q.distractorDomain);

  let domainTop3Hits = 0;
  let domainTop1Hits = 0;
  let knowledgeHits = 0;
  let evidenceHits = 0;
  let authoritativeCount = 0;
  let hardNegativeHits = 0;
  let multiDomainHits = 0;
  let distractorHits = 0;
  const details: PilotEvalDetail[] = [];

  for (let i = 0; i < queries.length; i += 1) {
    const query = queries[i]!;
    const result = results[i]!;

    const standard = !query.expectNoKnowledge && !query.expectedDomains && !query.distractorDomain;
    if (standard) {
      if (result.domainInTop3) domainTop3Hits += 1;
      if (result.domainTop1) domainTop1Hits += 1;
      if (result.knowledgePass) knowledgeHits += 1;
      if (result.authoritative && result.evidencePass) evidenceHits += 1;
      if (result.authoritative) authoritativeCount += 1;
    }
    if (query.expectNoKnowledge) {
      if (result.knowledgePass) hardNegativeHits += 1;
    }
    if (query.expectedDomains && query.expectedDomains.length > 0) {
      if (result.multiDomainPass) multiDomainHits += 1;
    }
    if (query.distractorDomain) {
      if (result.distractorPass) distractorHits += 1;
    }

    details.push(result.detail);
  }

  const standardCount = standardQueries.length;
  const hardNegativeCount = hardNegativeQueries.length;
  const multiDomainCount = multiDomainQueries.length;
  const distractorCount = distractorQueries.length;

  return {
    queryCount: queries.length,
    standardQueryCount: standardCount,
    domainRecallAt3: standardCount === 0 ? 0 : domainTop3Hits / standardCount,
    domainTop1: standardCount === 0 ? 0 : domainTop1Hits / standardCount,
    knowledgeRecallAt5: standardCount === 0 ? 0 : knowledgeHits / standardCount,
    evidenceCoverage: authoritativeCount === 0 ? 1 : evidenceHits / authoritativeCount,
    hardNegativePassRate: hardNegativeCount === 0 ? 1 : hardNegativeHits / hardNegativeCount,
    multiDomainResolution: multiDomainCount === 0 ? 1 : multiDomainHits / multiDomainCount,
    distractorTop3Rate: distractorCount === 0 ? 1 : distractorHits / distractorCount,
    domainQueries: standardCount,
    knowledgeQueries: standardCount,
    authoritativeQueries: authoritativeCount,
    hardNegativeQueries: hardNegativeCount,
    multiDomainQueries: multiDomainCount,
    distractorQueries: distractorCount,
    details,
  };
}

export function runPilotEval(input: {
  catalog: DisciplineCatalogSnapshot;
  knowledge: PilotKnowledgeEntry[];
  queries: PilotEvalQuery[];
  sources: PilotKnowledgeSource[];
}): PilotEvalMetrics {
  const sourceIds = new Set(input.sources.map((source) => source.id));
  const sourceSnapshots = buildSourceSnapshotIndex(input.sources);
  const results = input.queries.map((query) =>
    evaluatePilotQuery({
      catalog: input.catalog,
      knowledge: input.knowledge,
      query,
      sourceIds,
      sourceSnapshots,
    }),
  );
  return aggregatePilotMetrics(input.queries, results);
}
