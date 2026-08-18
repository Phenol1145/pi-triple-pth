/**
 * catalog/pilot-evaluator.ts — N23 K5 + F4 + R5 评测器。
 *
 * R5/P1-3：指标计算必须来自生产 KnowledgeContextProvider 端口（组装生产
 * DisciplineResolver + KnowledgeContextProvider），禁止评测器自行 resolve/filter/rank。
 * R5/P1-4：evidence 全链使用结构化 KnowledgeEvidenceRef[]（从 meta.evidence 读取）。
 */

import { createHash } from "node:crypto";
import {
  isVisible,
  validateKnowledgeEvidenceRefs,
  type KnowledgeEvidenceRef,
} from "@away_from/pth-memory";
import type { DisciplineCatalogSnapshot } from "./discipline-catalog.js";
import { createDisciplineResolver, type DisciplineResolver } from "./discipline-resolver.js";
import type { PilotKnowledgeEntry } from "./data/pilot-knowledge.js";
import type { PilotEvalQuery, PilotEvalQueryType } from "./data/pilot-eval-queries.js";
import type { PilotKnowledgeSource } from "./data/pilot-source-registry.js";
import { PILOT_SOURCE_SNAPSHOTS, artifactHashOf } from "./data/pilot-source-snapshots.js";
import type {
  KnowledgeContext,
  KnowledgeContextProvider,
  KnowledgeMemoryEntry,
} from "../runner/index.js";
import { createKnowledgeContextProvider } from "../runner/index.js";
import {
  createExecutionGrantService,
  createHmacGrantKeyProvider,
  createKnowledgeBroker,
  type KnowledgeBroker,
} from "../execution/index.js";

export interface PilotEvalMetrics {
  queryCount: number;
  standardQueryCount: number;
  /** 知识题（expectedEntryIds 非空且不属多域/混淆/hard-negative）：期望 domain 出现在 resolver.matches 前 3 */
  domainRecallAt3: number;
  /** 知识题：primaryDomain = 期望 domain 占比 */
  domainTop1: number;
  /** 知识题：期望 entryId 出现在 top-5 检索结果 */
  knowledgeRecallAt5: number;
  /** authoritative 查询命中条目 evidence 全部可溯源且非空 */
  evidenceCoverage: number;
  /** hard negative / no-answer：top5 为空占比（目标 ≥0.95） */
  hardNegativePassRate: number;
  /** 同域 no-answer：resolver 已解析到域但语料不支持 → 生产 Context 必须空 */
  noAnswerAbstention: number;
  /** 多域组合：resolver 前 3 包含全部 expectedDomains 占比（目标 1.0） */
  multiDomainResolution: number;
  /** 混淆题：primaryDomain=目标域或目标域在 top3 占比（目标 ≥0.9） */
  distractorTop3Rate: number;
  domainQueries: number;
  knowledgeQueries: number;
  authoritativeQueries: number;
  hardNegativeQueries: number;
  noAnswerQueries: number;
  multiDomainQueries: number;
  distractorQueries: number;
  /** 题集覆盖的知识条目数（去重 expectedEntryIds） */
  coveredEntries: number;
  coveredEntryIds: string[];
  /** holdout 冻结子集 */
  holdoutQueryCount: number;
  holdoutPassRate: number;
  /** holdout 冻结 digest（与 seed/alias 生成隔离） */
  holdoutDigest: string;
  queryTypeCounts: Record<PilotEvalQueryType, number>;
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
const DEFAULT_TENANT_ID = "default";
const DEFAULT_SPACE = "meta";
const EVAL_ROLE_ID = "pilot-evaluator";

export function queryTypeOf(query: PilotEvalQuery): PilotEvalQueryType {
  if (query.type) return query.type;
  if (query.expectNoKnowledge) return "hard-negative";
  if (query.expectedDomains && query.expectedDomains.length > 0) return "multi-domain";
  if (query.distractorDomain) return "distractor";
  return "standard";
}

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

export interface PilotEvalProductionPort {
  resolver: DisciplineResolver;
  contextProvider: KnowledgeContextProvider;
  /** 生产 KnowledgeBroker（组装完整性；评测判分走 contextProvider 生产端口） */
  broker?: KnowledgeBroker;
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
  /** conflict：全部 conflictSourceIds 都出现在 top5 evidence 中 */
  conflictPass?: boolean;
  /** version：全部 expectedSourceVersions 均匹配 top5 evidence 的 sourceId+sourceVersion */
  versionPass?: boolean;
  /** irrelevant：无关 entryId 不得进入 top5 */
  irrelevantPass?: boolean;
  /** 生产 Context 返回的 top5 条目 id（供报告/调参冻结） */
  top5Ids: string[];
  /** 生产 Context 返回的 top5 条目 evidence（全链结构化） */
  top5Evidence: KnowledgeEvidenceRef[];
}

function sourceKeyMatches(evidenceSourceId: string, expectedSourceId: string): boolean {
  return evidenceSourceId === expectedSourceId
    || evidenceSourceId === `pilot-source:${expectedSourceId}`
    || `pilot-source:${evidenceSourceId}` === expectedSourceId;
}

function evidenceSourceIds(top5: KnowledgeContext["entries"]): string[] {
  return top5.flatMap((entry) => entry.evidence.map((ref) => ref.sourceId));
}

function evidenceVersionMatches(
  ref: KnowledgeEvidenceRef,
  expected: { sourceId: string; sourceVersion?: string },
): boolean {
  if (!sourceKeyMatches(ref.sourceId, expected.sourceId)) return false;
  if (expected.sourceVersion === undefined) return true;
  return ref.sourceVersion === expected.sourceVersion;
}

export async function evaluatePilotQueryWithPort(input: {
  port: PilotEvalProductionPort;
  query: PilotEvalQuery;
  sourceIds: ReadonlySet<string>;
  sourceSnapshots?: ReadonlyMap<string, PilotSourceSnapshotIntegrity>;
}): Promise<PilotQueryEvalResult> {
  const { port, query } = input;

  // 生产 DomainResolver：评测不自行做 alias 扫描。
  const resolved = port.resolver.resolve({
    title: query.text.slice(0, 80),
    text: query.text,
    tags: [],
    explicitDomains: [],
  });

  const matchDomainIds = resolved.ok
    ? resolved.binding.matches.map((match) => match.domainId)
    : [];
  const domainInTop3 = matchDomainIds.slice(0, DOMAIN_TOP_N).includes(query.domain);
  const domainTop1 = resolved.ok && resolved.binding.primaryDomain === query.domain;

  // 生产 KnowledgeContextProvider：评测不自行 retrieve/filter/rank。
  const context = await port.contextProvider.build({
    tenantId: query.tenantId ?? DEFAULT_TENANT_ID,
    space: query.space ?? DEFAULT_SPACE,
    roleId: EVAL_ROLE_ID,
    domains: matchDomainIds,
    title: query.text.slice(0, 80),
    text: query.text,
    catalogVersion: "",
  });

  const top5 = context.entries.slice(0, KNOWLEDGE_TOP_N);
  const top5Ids = top5.map((entry) => entry.entryId);
  const top5Evidence = top5.flatMap((entry) => entry.evidence);

  let knowledgePass: boolean;
  if (query.expectNoKnowledge) {
    knowledgePass = top5Ids.length === 0;
  } else if (query.expectedEntryIds.length > 0) {
    const hitExpected = query.expectedEntryIds.filter((id) => top5Ids.includes(id));
    knowledgePass = hitExpected.length > 0;
  } else {
    // 多域/混淆题不断言 knowledge
    knowledgePass = true;
  }

  let evidencePass = true;
  if (query.authoritative) {
    evidencePass = top5.length > 0
      && top5.every((entry) => entry.evidence.length > 0)
      && top5.every((entry) =>
        entry.evidence.every((evidence) => isEvidenceSourceOk(evidence.sourceId, input.sourceIds, input.sourceSnapshots)),
      );
  }

  const multiDomainPass = query.expectedDomains && query.expectedDomains.length > 0
    ? query.expectedDomains.every((domain) => matchDomainIds.slice(0, DOMAIN_TOP_N).includes(domain))
    : undefined;

  const distractorPass = query.distractorDomain
    ? domainTop1 || domainInTop3
    : undefined;

  const conflictPass = query.conflictSourceIds && query.conflictSourceIds.length > 0
    ? query.conflictSourceIds.every((expected) =>
        evidenceSourceIds(top5).some((actual) => sourceKeyMatches(actual, expected)),
      )
    : undefined;

  const versionPass = query.expectedSourceVersions && query.expectedSourceVersions.length > 0
    ? query.expectedSourceVersions.every((expected) =>
        top5Evidence.some((ref) => evidenceVersionMatches(ref, expected)),
      )
    : undefined;

  const irrelevantPass = query.irrelevantEntryIds && query.irrelevantEntryIds.length > 0
    ? query.irrelevantEntryIds.every((id) => !top5Ids.includes(id))
    : undefined;

  let pass: boolean;
  if (query.expectNoKnowledge) {
    pass = knowledgePass;
  } else if (query.expectedDomains && query.expectedDomains.length > 0) {
    pass = multiDomainPass === true;
  } else if (query.distractorDomain) {
    pass = distractorPass === true;
  } else {
    pass = domainInTop3
      && knowledgePass
      && (!query.authoritative || evidencePass)
      && (conflictPass === undefined || conflictPass)
      && (versionPass === undefined || versionPass)
      && (irrelevantPass === undefined || irrelevantPass);
  }

  let reason: string | undefined;
  if (!pass) {
    const reasons: string[] = [];
    if (!resolved.ok) {
      reasons.push(`resolver error: ${resolved.error}`);
    } else if (query.expectNoKnowledge) {
      if (!knowledgePass) {
        reasons.push(`hard negative expected empty top5 but got [${top5Ids.join(", ")}]`);
      }
    } else if (query.expectedDomains && query.expectedDomains.length > 0) {
      if (!multiDomainPass) {
        reasons.push(
          `expected domains [${query.expectedDomains.join(", ")}] not all in top3 (got ${matchDomainIds.slice(0, DOMAIN_TOP_N).join(", ") || "none"})`,
        );
      }
    } else if (query.distractorDomain) {
      if (!distractorPass) {
        reasons.push(
          `expected primaryDomain=${query.domain} or target in top3 (got primary=${resolved.binding.primaryDomain ?? "none"}, top3=${matchDomainIds.slice(0, DOMAIN_TOP_N).join(", ") || "none"})`,
        );
      }
    } else {
      if (!domainInTop3) {
        reasons.push(
          `expected domain ${query.domain} not in top3 matches (got ${matchDomainIds.slice(0, DOMAIN_TOP_N).join(", ") || "none"})`,
        );
      }
      if (!knowledgePass) {
        reasons.push(
          `expected entries [${query.expectedEntryIds.join(", ")}] not in top5 [${top5Ids.join(", ") || "none"}]`,
        );
      }
      if (query.authoritative && !evidencePass) {
        if (top5.length === 0) {
          reasons.push("authoritative query got empty top5");
        }
        const emptyEvidence = top5.filter((entry) => entry.evidence.length === 0).map((entry) => entry.entryId);
        if (emptyEvidence.length > 0) {
          reasons.push(`empty evidence in entries: ${emptyEvidence.join(", ")}`);
        }
        const missing = top5
          .flatMap((entry) =>
            entry.evidence
              .filter((evidence) => !isEvidenceSourceOk(evidence.sourceId, input.sourceIds, input.sourceSnapshots))
              .map((evidence) => `${entry.entryId}:${evidence.sourceId}`),
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
              .map((evidence) => `${entry.entryId}:${evidence.sourceId}`),
          );
        if (drift.length > 0) {
          reasons.push(`evidence source snapshot drift: ${drift.join(", ")}`);
        }
      }
      if (conflictPass === false) {
        reasons.push(`conflict sources [${query.conflictSourceIds?.join(", ")}] not all present in top5 evidence`);
      }
      if (versionPass === false) {
        reasons.push(
          `expected source versions [${query.expectedSourceVersions?.map((v) => `${v.sourceId}@${v.sourceVersion ?? ""}`).join(", ")}] not matched in top5 evidence`,
        );
      }
      if (irrelevantPass === false) {
        reasons.push(`irrelevant entries ${query.irrelevantEntryIds?.filter((id) => top5Ids.includes(id)).join(", ")} appeared in top5`);
      }
    }
    reason = reasons.join("; ");
  }

  return {
    detail: { queryId: query.id, domain: query.domain, pass, reason },
    domainInTop3,
    domainTop1,
    knowledgePass,
    evidencePass,
    authoritative: query.authoritative,
    multiDomainPass,
    distractorPass,
    conflictPass,
    versionPass,
    irrelevantPass,
    top5Ids,
    top5Evidence,
  };
}

/** 把 sources + snapshots 组成 evidence 校验索引（离线）。sourceId 同时支持短 id 与 pilot-source:<id>。 */
export function buildSourceSnapshotIndex(sources: readonly PilotKnowledgeSource[]): ReadonlyMap<string, PilotSourceSnapshotIntegrity> {
  const snapshotBySource = new Map(PILOT_SOURCE_SNAPSHOTS.map((snapshot) => [snapshot.sourceId, snapshot]));
  const out = new Map<string, PilotSourceSnapshotIntegrity>();
  for (const source of sources) {
    const snapshot = snapshotBySource.get(source.id);
    const integrity: PilotSourceSnapshotIntegrity = {
      artifactHash: source.artifactHash,
      snapshotContent: snapshot?.snapshotContent ?? "",
    };
    out.set(source.id, integrity);
    out.set(`pilot-source:${source.id}`, integrity);
  }
  return out;
}

function buildSourceIds(sources: readonly PilotKnowledgeSource[]): Set<string> {
  const out = new Set<string>();
  for (const source of sources) {
    out.add(source.id);
    out.add(`pilot-source:${source.id}`);
  }
  return out;
}

function sourceById(sources: readonly PilotKnowledgeSource[]): Map<string, PilotKnowledgeSource> {
  return new Map(sources.map((source) => [source.id, source]));
}

/** 离线知识 → 生产 Context 可消费的 memory 条目；meta.evidence 与 seed 同构（sourceVersion+artifactHash）。 */
function toKnowledgeMemoryEntry(
  entry: PilotKnowledgeEntry,
  sources: readonly PilotKnowledgeSource[],
): KnowledgeMemoryEntry {
  const byId = sourceById(sources);
  const evidence: KnowledgeEvidenceRef[] = entry.evidence.map((e) => {
    const source = byId.get(e.sourceId);
    return {
      sourceId: `pilot-source:${e.sourceId}`,
      locator: e.locator,
      ...(source?.version !== undefined ? { sourceVersion: source.version } : {}),
      ...(source?.artifactHash !== undefined ? { artifactHash: source.artifactHash } : {}),
    };
  });
  const checked = validateKnowledgeEvidenceRefs(evidence);
  if (!checked.ok) {
    throw new Error(`pilot evaluator: invalid evidence for ${entry.id}: ${checked.error}`);
  }
  return {
    id: entry.id,
    kind: entry.kind,
    anchors: entry.anchors,
    status: "official",
    content: entry.content,
    meta: { version: 1, evidence },
  };
}

function createOfflinePilotMemory(knowledge: readonly PilotKnowledgeEntry[], sources: readonly PilotKnowledgeSource[]) {
  const rows = knowledge.map((entry) => toKnowledgeMemoryEntry(entry, sources));
  return {
    async retrieve(opts: { anchors?: string[]; kinds?: string[]; status?: string[]; tenantId?: string }): Promise<KnowledgeMemoryEntry[]> {
      const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
      const anchors = opts.anchors ?? [];
      const kinds = opts.kinds ?? [];
      const status = opts.status ?? [];
      return rows
        .filter((row) => {
          if (tenantId !== DEFAULT_TENANT_ID) return false;
          if (anchors.length > 0 && !row.anchors.some((anchor) => anchors.includes(anchor))) return false;
          if (kinds.length > 0 && !kinds.includes(row.kind)) return false;
          if (status.length > 0 && !status.includes(row.status)) return false;
          return true;
        })
        .sort((a, b) => compareIds(a.id, b.id));
    },
    async get(id: string, opts?: { tenantId?: string }): Promise<KnowledgeMemoryEntry | undefined> {
      if (opts?.tenantId && opts.tenantId !== DEFAULT_TENANT_ID) return undefined;
      return rows.find((row) => row.id === id);
    },
  };
}

/** holdout 子集冻结 digest：只依赖冻结查询字段，不依赖 seed/alias 生成物。 */
export function computeHoldoutDigest(queries: readonly PilotEvalQuery[]): string {
  const rows = queries
    .filter((q) => q.holdout)
    .sort((a, b) => compareIds(a.id, b.id))
    .map((q) => [
      q.id,
      q.domain,
      q.text,
      q.authoritative,
      q.expectedEntryIds.join("\n"),
      q.expectNoKnowledge ?? false,
      (q.expectedDomains ?? []).join("\n"),
      q.distractorDomain ?? "",
      q.type ?? "",
      q.tenantId ?? "",
      q.space ?? "",
      (q.irrelevantEntryIds ?? []).join("\n"),
      (q.conflictSourceIds ?? []).join("\n"),
      q.versionExpectation ?? "",
      (q.expectedSourceVersions ?? []).map((v) => `${v.sourceId}@${v.sourceVersion ?? ""}`).join("\n"),
    ].join("|"));
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

/** 把逐题结果按题型分区聚合成指标（离线/live 共用）。 */
export function aggregatePilotMetrics(
  queries: readonly PilotEvalQuery[],
  results: readonly PilotQueryEvalResult[],
): PilotEvalMetrics {
  const knowledgeQueries = queries.filter((q) =>
    !q.expectNoKnowledge
    && !(q.expectedDomains && q.expectedDomains.length > 0)
    && !q.distractorDomain
    && q.expectedEntryIds.length > 0,
  );
  const hardNegativeQueries = queries.filter((q) => q.expectNoKnowledge);
  const noAnswerQueries = queries.filter((q) => queryTypeOf(q) === "no-answer-same-domain");
  const multiDomainQueries = queries.filter((q) => !!q.expectedDomains && q.expectedDomains.length > 0);
  const distractorQueries = queries.filter((q) => !!q.distractorDomain);
  const holdoutQueries = queries.filter((q) => q.holdout);

  let domainTop3Hits = 0;
  let domainTop1Hits = 0;
  let knowledgeHits = 0;
  let evidenceHits = 0;
  let authoritativeCount = 0;
  let hardNegativeHits = 0;
  let noAnswerHits = 0;
  let multiDomainHits = 0;
  let distractorHits = 0;
  let holdoutHits = 0;
  const details: PilotEvalDetail[] = [];
  const covered = new Set<string>();
  const queryTypeCounts = new Map<PilotEvalQueryType, number>();

  for (let i = 0; i < queries.length; i += 1) {
    const query = queries[i]!;
    const result = results[i]!;
    const type = queryTypeOf(query);
    queryTypeCounts.set(type, (queryTypeCounts.get(type) ?? 0) + 1);

    for (const id of query.expectedEntryIds) covered.add(id);

    const knowledgeQuery = !query.expectNoKnowledge
      && !(query.expectedDomains && query.expectedDomains.length > 0)
      && !query.distractorDomain
      && query.expectedEntryIds.length > 0;
    if (knowledgeQuery) {
      if (result.domainInTop3) domainTop3Hits += 1;
      if (result.domainTop1) domainTop1Hits += 1;
      if (result.knowledgePass) knowledgeHits += 1;
      if (result.authoritative && result.evidencePass) evidenceHits += 1;
      if (result.authoritative) authoritativeCount += 1;
    }
    if (query.expectNoKnowledge) {
      if (result.knowledgePass) hardNegativeHits += 1;
    }
    if (type === "no-answer-same-domain") {
      if (result.knowledgePass) noAnswerHits += 1;
    }
    if (query.expectedDomains && query.expectedDomains.length > 0) {
      if (result.multiDomainPass) multiDomainHits += 1;
    }
    if (query.distractorDomain) {
      if (result.distractorPass) distractorHits += 1;
    }
    if (query.holdout) {
      if (result.detail.pass) holdoutHits += 1;
    }

    details.push(result.detail);
  }

  const knowledgeCount = knowledgeQueries.length;
  const hardNegativeCount = hardNegativeQueries.length;
  const noAnswerCount = noAnswerQueries.length;
  const multiDomainCount = multiDomainQueries.length;
  const distractorCount = distractorQueries.length;
  const holdoutCount = holdoutQueries.length;
  const coveredEntryIds = [...covered].sort(compareIds);

  return {
    queryCount: queries.length,
    standardQueryCount: knowledgeCount,
    domainRecallAt3: knowledgeCount === 0 ? 0 : domainTop3Hits / knowledgeCount,
    domainTop1: knowledgeCount === 0 ? 0 : domainTop1Hits / knowledgeCount,
    knowledgeRecallAt5: knowledgeCount === 0 ? 0 : knowledgeHits / knowledgeCount,
    evidenceCoverage: authoritativeCount === 0 ? 1 : evidenceHits / authoritativeCount,
    hardNegativePassRate: hardNegativeCount === 0 ? 1 : hardNegativeHits / hardNegativeCount,
    noAnswerAbstention: noAnswerCount === 0 ? 1 : noAnswerHits / noAnswerCount,
    multiDomainResolution: multiDomainCount === 0 ? 1 : multiDomainHits / multiDomainCount,
    distractorTop3Rate: distractorCount === 0 ? 1 : distractorHits / distractorCount,
    domainQueries: knowledgeCount,
    knowledgeQueries: knowledgeCount,
    authoritativeQueries: authoritativeCount,
    hardNegativeQueries: hardNegativeCount,
    noAnswerQueries: noAnswerCount,
    multiDomainQueries: multiDomainCount,
    distractorQueries: distractorCount,
    coveredEntries: coveredEntryIds.length,
    coveredEntryIds,
    holdoutQueryCount: holdoutCount,
    holdoutPassRate: holdoutCount === 0 ? 1 : holdoutHits / holdoutCount,
    holdoutDigest: computeHoldoutDigest(queries),
    queryTypeCounts: Object.fromEntries(queryTypeCounts) as Record<PilotEvalQueryType, number>,
    details,
  };
}

/** 生产端口评测（离线/live 共用）：逐 query 调用 resolver + KnowledgeContextProvider。 */
export async function runPilotEvalWithPort(input: {
  port: PilotEvalProductionPort;
  queries: PilotEvalQuery[];
  sourceIds: ReadonlySet<string>;
  sourceSnapshots?: ReadonlyMap<string, PilotSourceSnapshotIntegrity>;
}): Promise<PilotEvalMetrics> {
  const results: PilotQueryEvalResult[] = [];
  for (const query of input.queries) {
    results.push(await evaluatePilotQueryWithPort({
      port: input.port,
      query,
      sourceIds: input.sourceIds,
      sourceSnapshots: input.sourceSnapshots,
    }));
  }
  return aggregatePilotMetrics(input.queries, results);
}

/**
 * 离线可复现评测：组装生产 DisciplineResolver + KnowledgeContextProvider（生产端口），
 * memory 使用离线知识条目构造；指标计算完全来自生产端口返回值。
 */
export async function runPilotEval(input: {
  catalog: DisciplineCatalogSnapshot;
  knowledge: PilotKnowledgeEntry[];
  queries: PilotEvalQuery[];
  sources: PilotKnowledgeSource[];
}): Promise<PilotEvalMetrics> {
  const memory = createOfflinePilotMemory(input.knowledge, input.sources);
  const isVisibleFn = (meta: Record<string, unknown> | undefined, space: string) => isVisible(meta, space);
  const grantService = createExecutionGrantService({
    keyProvider: createHmacGrantKeyProvider({ secret: "pilot-eval-r5-offline-secret-0123456789" }),
    clock: () => new Date(),
  });
  const broker = createKnowledgeBroker({
    grantService,
    dataWorld: {
      queryReadOnly: async () => [],
      memory,
    },
    isVisible: isVisibleFn,
  });
  const port: PilotEvalProductionPort = {
    resolver: createDisciplineResolver(input.catalog),
    contextProvider: createKnowledgeContextProvider({
      catalog: input.catalog,
      memory,
      isVisible: isVisibleFn,
    }),
    broker,
  };
  const sourceIds = buildSourceIds(input.sources);
  const sourceSnapshots = buildSourceSnapshotIndex(input.sources);
  return runPilotEvalWithPort({
    port,
    queries: input.queries,
    sourceIds,
    sourceSnapshots,
  });
}

export interface MutationEvalReport {
  totalMutations: number;
  detectedMutations: number;
  mutationScore: number;
  rows: Array<{
    entryId: string;
    removeDetected: boolean;
    evidenceDetected: boolean;
    baselinePass: number;
    removePass: number;
    evidencePassRate: number;
    failedQueryIds: string[];
  }>;
}

/** 对每条知识逐一反事实破坏：删除条目 / 清空 evidence，断言对应题集指标下降。 */
export async function runMutationEval(input: {
  catalog: DisciplineCatalogSnapshot;
  knowledge: PilotKnowledgeEntry[];
  queries: PilotEvalQuery[];
  sources: PilotKnowledgeSource[];
}): Promise<MutationEvalReport> {
  const baseline = await runPilotEval(input);
  const targetedQueries = new Map<string, PilotEvalQuery[]>();
  for (const entry of input.knowledge) {
    targetedQueries.set(entry.id, input.queries.filter((q) => q.expectedEntryIds.includes(entry.id)));
  }

  const rows: MutationEvalReport["rows"] = [];
  for (const entry of input.knowledge) {
    const queries = targetedQueries.get(entry.id) ?? [];
    const baselinePass = baseline.details.filter((d) =>
      queries.some((q) => q.id === d.queryId) && d.pass,
    ).length;

    // 反事实 1：删除条目——对应题集必然失配。
    const removedKnowledge = input.knowledge.filter((k) => k.id !== entry.id);
    const removed = await runPilotEval({ ...input, knowledge: removedKnowledge, queries });
    const removePass = removed.details.filter((d) => d.pass).length;

    // 反事实 2：清空 evidence——authoritative 题集 evidenceCoverage 必然下降。
    const evidenceKnowledge = input.knowledge.map((k) =>
      k.id === entry.id ? { ...k, evidence: [] as PilotKnowledgeEntry["evidence"] } : k,
    );
    const evidenceEval = await runPilotEval({ ...input, knowledge: evidenceKnowledge, queries });
    const evidencePass = evidenceEval.details.filter((d) => d.pass).length;

    const failedQueryIds = removed.details
      .filter((d, idx) => !d.pass && queries[idx]?.id === d.queryId)
      .map((d) => d.queryId);

    rows.push({
      entryId: entry.id,
      removeDetected: removePass < baselinePass,
      evidenceDetected: evidencePass < baselinePass,
      baselinePass,
      removePass,
      evidencePassRate: evidencePass,
      failedQueryIds,
    });
  }

  const detectedMutations = rows.filter((row) => row.removeDetected || row.evidenceDetected).length;
  return {
    totalMutations: rows.length,
    detectedMutations,
    mutationScore: rows.length === 0 ? 1 : detectedMutations / rows.length,
    rows,
  };
}
