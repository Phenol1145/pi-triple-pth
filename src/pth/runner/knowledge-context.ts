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

import type { DomainId } from "../contracts/index.js";
import type { DisciplineCatalogSnapshot } from "../catalog/index.js";
import { rankKnowledgeEntries } from "../execution/index.js";

export interface KnowledgeContextEntry {
  entryId: string;
  /** meta.version ?? 1 */
  version: number;
  /** 第一个 anchor（展示用） */
  anchor: string;
  /** content 前 summaryChars 字符（单行化） */
  summary: string;
  /** meta.provenance ?? null */
  evidence: unknown;
}

export interface KnowledgeContext {
  /** kc-<queryFingerprint> */
  id: string;
  catalogVersion: string;
  queryFingerprint: string;
  domains: DomainId[];
  entries: KnowledgeContextEntry[];
  omitted: { count: number; reason: string };
}

export interface KnowledgeContextInput {
  tenantId: string;
  space: string;
  roleId: string;
  domains: readonly DomainId[];
  title: string;
  text: string;
  catalogVersion: string;
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
  catalog?: DisciplineCatalogSnapshot;
  /** K1a 同款空间可见性判定。 */
  isVisible(meta: Record<string, unknown> | undefined, space: string): boolean;
  maxEntries?: number;
  summaryChars?: number;
}

export const KNOWLEDGE_CONTEXT_KINDS = ["domain-fact", "domain-method", "skill", "task-insight"] as const;
const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_SUMMARY_CHARS = 240;

/** FNV-1a 32-bit → 8 位 hex 指纹。 */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** §1 指纹函数：tenantId|space|roleId|domains(排序)|title|text|catalogVersion 的 \n join。 */
export function computeKnowledgeQueryFingerprint(input: KnowledgeContextInput): string {
  const domains = [...input.domains].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return fnv1aHex([
    input.tenantId,
    input.space,
    input.roleId,
    domains.join("\n"),
    input.title,
    input.text,
    input.catalogVersion,
  ].join("\n"));
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

      const sorted = rankKnowledgeEntries(visible, {
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
        evidence: e.meta?.["provenance"] ?? null,
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
