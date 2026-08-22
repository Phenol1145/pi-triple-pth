/**
 * runner/knowledge-context.ts — 有界、可复现、版本化的任务知识上下文（K3 Phase 3）。
 *
 * 与 KnowledgeBroker 的关系：本文件负责任务 claim 后的一次性上下文快照；
 * worker 执行期按需展开走 broker 的窄 search/get（execution/knowledge-broker.ts）。
 *
 * 确定性约定：
 *  - queryFingerprint = FNV-1a 32bit（tenantId|space|roleId|domains(排序)|title|text|catalogVersion
 *    的 \n join）转 8 位 hex；同输入同 catalog 同数据版本 → 同 id；
 *  - 排序：rankKnowledgeEntries（domainRelevance * 1000 + queryTokenHits 降序 → id 升序）；
 *    超 maxEntries 记 omitted={count, reason:"budget"}。
 */

import type { KnowledgeEvidenceRef } from "@away_from/pth-memory";
import { knowledgeEvidenceRefsFromMeta } from "@away_from/pth-memory";
import type { DisciplineCatalogLike, DomainId, PendingRetrievalTrace, RetrievalWaveTrace } from "@away_from/pth-contracts";
import {
  assertVerifiedTaskReadScope,
  computeRetrievalQueryFingerprint,
  filterKnowledgeEntriesByQueryText,
  rankKnowledgeEntries,
  type LayeredKnowledgeRetriever,
  type LayeredSearchWaveInput,
  type LayeredSearchWaveResult,
  type RetrievalStatus,
  type VerifiedTaskReadScope,
} from "../execution/index.js";

import { computeKnowledgeQueryFingerprint } from "@away_from/pth-contracts";
export { computeKnowledgeQueryFingerprint, fnv1aHex } from "@away_from/pth-contracts";

export interface KnowledgeContextPromptRow {
  entryId: string;
  anchor: string;
  summary: string;
  evidence: readonly { sourceId: string; locator?: string }[];
  meta: Readonly<{ kind: string; domains: readonly string[] }>;
}

export interface KnowledgeContextEntry {
  entryId: string;
  /** meta.version ?? 1 */
  version: number;
  /** 第一个 anchor（展示用） */
  anchor: string;
  /** content 前 summaryChars 字符（单行化） */
  summary: string;
  /** 结构化 KnowledgeEvidenceRef[]（从 meta.evidence 读取；无 evidence 时为空数组，不伪装 provenance） */
  evidence: KnowledgeEvidenceRef[];
  /** 白名单暴露元数据（只用于 prompt/billing 投影，绝不透传任意存储 meta）。 */
  exposedMeta: Readonly<{ kind: string; domains: readonly DomainId[] }>;
}

export interface KnowledgeContext {
  /** kc-<queryFingerprint> */
  id: string;
  catalogVersion: string;
  queryFingerprint: string;
  domains: DomainId[];
  entries: KnowledgeContextEntry[];
  omitted: { count: number; reason: string };
  /** N28 T4：layered 路径的不可变 trace（无 trace = legacy 路径）。 */
  retrievalTrace?: PendingRetrievalTrace & { waves: Array<RetrievalWaveTrace & { selectedEntryIds: string[] }> };
  retrievalStatus?: RetrievalStatus;
}

export interface KnowledgeContextInput {
  tenantId: string;
  space: string;
  roleId: string;
  domains: readonly DomainId[];
  title: string;
  text: string;
  catalogVersion: string;
  /** N28 T4：layered 路径 worker 绑定（指纹的独立分量；缺席=旧指纹逐字节不变）。 */
  workerId?: string;
  /** N28 T4：已验证任务读取 envelope（layered 路径强制要求）。 */
  authorization?: VerifiedTaskReadScope;
}

export interface KnowledgeContextProvider {
  build(input: KnowledgeContextInput): Promise<KnowledgeContext>;
}

/** memory.retrieve 窄口（K1a 接口 + tenantId）。 */
export interface KnowledgeMemoryEntry {
  id: string;
  kind: string;
  anchors: string[];
  status: string;
  content: string;
  meta?: Record<string, unknown>;
}

export interface KnowledgeContextProviderDeps {
  memory: {
    retrieve(opts: { anchors?: string[]; kinds?: string[]; status?: string[]; tenantId?: string }): Promise<KnowledgeMemoryEntry[]>;
  };
  /** K2 同一份 catalog 快照——提供 catalogVersion + ancestors 展开。 */
  catalog?: DisciplineCatalogLike;
  /** K1a 同款空间可见性判定。 */
  isVisible(meta: Record<string, unknown> | undefined, space: string): boolean;
  maxEntries?: number;
  summaryChars?: number;
  /** N28 T4：layered 路径组件（与 Broker 共用同一 retriever/clock）。 */
  layeredRetriever?: LayeredKnowledgeRetriever<KnowledgeMemoryEntry>;
  layeredSearchWave?: (input: LayeredSearchWaveInput) => Promise<LayeredSearchWaveResult<KnowledgeMemoryEntry>>;
  clock?: () => Date;
}

export const KNOWLEDGE_CONTEXT_KINDS = ["domain-fact", "domain-method", "skill", "task-insight"] as const;
const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_SUMMARY_CHARS = 240;

/** N28 T4：冻结 prompt/billing 投影——只含白名单字段，绝不透传任意存储 meta。 */
export function contextPromptProjection(entry: KnowledgeContextEntry): KnowledgeContextPromptRow {
  return {
    entryId: entry.entryId,
    anchor: entry.anchor,
    summary: entry.summary,
    evidence: entry.evidence.map((e) => ({ sourceId: e.sourceId, ...(e.locator ? { locator: e.locator } : {}) })),
    meta: { kind: entry.exposedMeta.kind, domains: [...entry.exposedMeta.domains] },
  };
}

export function formatKnowledgeContextPromptRows(rows: readonly KnowledgeContextPromptRow[]): string {
  return rows.map((row) =>
    `- [${row.entryId}] ${row.anchor}: ${row.summary}` +
    ` evidence=${JSON.stringify(row.evidence)} meta=${JSON.stringify(row.meta)}`
  ).join("\n");
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toVersion(meta: Record<string, unknown> | undefined): number {
  const version = meta?.["version"];
  return typeof version === "number" && Number.isFinite(version) ? version : 1;
}

export function createKnowledgeContextProvider(deps: KnowledgeContextProviderDeps): KnowledgeContextProvider {
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const summaryChars = deps.summaryChars ?? DEFAULT_SUMMARY_CHARS;
  const clock = deps.clock ?? (() => new Date());

  return {
    async build(input) {
      const domains = [...new Set(input.domains)].sort(compareIds);
      // catalog 存在时以快照版本为准（与 K2 resolver 同源同版本）；否则使用输入 catalogVersion。
      const catalogVersion = deps.catalog?.version ?? input.catalogVersion;
      const fingerprintInput: KnowledgeContextInput = { ...input, domains, catalogVersion };
      const queryFingerprint = computeKnowledgeQueryFingerprint(fingerprintInput);

      if (domains.length === 0) {
        return {
          id: `kc-${queryFingerprint}`,
          catalogVersion,
          queryFingerprint,
          domains,
          entries: [],
          omitted: { count: 0, reason: "budget" },
        };
      }

      // N28 T4：layered 路径——与 Broker 共用同一 retriever/授权 envelope；dep 缺失时走 legacy 原路径。
      if (deps.layeredRetriever && deps.layeredSearchWave && input.authorization) {
        assertVerifiedTaskReadScope(input.authorization, {
          tenantId: input.tenantId,
          ...(input.workerId !== undefined ? { workerId: input.workerId } : {}),
        }, { clock });
        const layeredFingerprint = computeRetrievalQueryFingerprint({
          authorization: input.authorization,
          queryText: input.text,
          domains,
          directorySnapshotId: deps.layeredRetriever.directory.snapshotId,
        });
        const result = await deps.layeredRetriever.search({
          authorization: input.authorization,
          workerId: input.workerId ?? input.authorization.worker.workerId,
          queryText: input.text,
          queryFingerprint: layeredFingerprint,
          domains,
          limit: maxEntries,
          // P1-1 修复：Context 与 Broker 共用同一注入 wave port，不再内联第二套
          // 授权/过滤/排序逻辑（trace 的 candidate/visible/scanned 由同一端口诚实声明）。
          searchWave: deps.layeredSearchWave,
        });
        const contextEntries: KnowledgeContextEntry[] = result.status === "found"
          ? result.entries.map((e) => ({
              entryId: e.id,
              version: toVersion(e.meta),
              anchor: e.anchors[0] ?? "",
              summary: singleLine(e.content.slice(0, summaryChars)),
              evidence: knowledgeEvidenceRefsFromMeta(e.meta),
              exposedMeta: {
                kind: e.kind,
                domains: (Array.isArray(e.meta?.["domains"]) ? (e.meta!["domains"] as string[]) : []).filter((d): d is DomainId => domains.includes(d as DomainId)),
              },
            }))
          : [];
        return {
          id: `kc-${layeredFingerprint}`,
          catalogVersion,
          queryFingerprint: layeredFingerprint,
          domains,
          entries: contextEntries,
          omitted: { count: result.status === "found" ? 0 : result.entries.length, reason: result.status },
          retrievalTrace: result.trace,
          retrievalStatus: result.status,
        };
      }

      const entries = await deps.memory.retrieve({
        anchors: domains,
        kinds: [...KNOWLEDGE_CONTEXT_KINDS],
        status: ["official"],
        tenantId: input.tenantId,
      });
      const visible = entries.filter((e) => deps.isVisible(e.meta, input.space));

      // F4 AB-07：统一走 query-sensitive ranking（score = domainRelevance * 1000 + queryTokenHits）。
      // 命中面 = domains + 必要祖先（catalog 存在时展开；ancestors 含自身，深度稳定序）。
      const domainAncestors: DomainId[] = [];
      if (deps.catalog) {
        const seen = new Set<DomainId>(domains);
        for (const domain of domains) {
          for (const ancestor of deps.catalog.ancestors(domain)) {
            if (!seen.has(ancestor)) {
              seen.add(ancestor);
              domainAncestors.push(ancestor);
            }
          }
        }
      }

      // R5/P1-3：生产 Context 与评测同走 strict——零命中 fail-closed 返回空，不回退任意 top-5。
      const relevant = filterKnowledgeEntriesByQueryText(visible, input.text, { strict: true });

      const sorted = rankKnowledgeEntries(relevant, {
        queryText: input.text,
        domains,
        domainAncestors,
      });

      const selected = sorted.slice(0, maxEntries);
      const contextEntries: KnowledgeContextEntry[] = selected.map((e) => ({
        entryId: e.id,
        version: toVersion(e.meta),
        anchor: e.anchors[0] ?? "",
        summary: singleLine(e.content.slice(0, summaryChars)),
        evidence: knowledgeEvidenceRefsFromMeta(e.meta),
        exposedMeta: {
          kind: e.kind,
          domains: (Array.isArray(e.meta?.["domains"]) ? (e.meta!["domains"] as string[]) : []).filter((d): d is DomainId => domains.includes(d as DomainId)),
        },
      }));

      return {
        id: `kc-${queryFingerprint}`,
        catalogVersion,
        queryFingerprint,
        domains,
        entries: contextEntries,
        omitted: { count: sorted.length - contextEntries.length, reason: "budget" },
      };
    },
  };
}
