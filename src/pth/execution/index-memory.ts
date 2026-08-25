/**
 * execution/index-memory.ts —— v1.3 P0 Task 1：Index Memory 惰性精确读取。
 *
 * Index Memory 只保存导航元数据（“有什么、在哪里、哪个版本、如何精确读取”），
 * 绝不保存语料正文。正文只能经 readExact() 按精确 locator 读取一个引用 span：
 *   1. 复用 VerifiedTaskReadScope 的 tenant/space/grant/deadline 廉价断言（先授权）；
 *   2. 授权通过后才调用 backing source adapter 读取一个精确 span；
 *   3. 校验 span 的 tenant/space/status/artifactHash/locator 同一性（fail-closed，
 *      未命中精确 locator 绝不退化为整份语料载入）；
 *   4. 按返回 span 的实际字符数走同一 CognitiveBudgetLedger 计费。
 *
 * 本模块不提供 readWholeCorpus()——按设计，Index Memory 不存在整份语料读取面。
 */

import { canonicalExposureChars, CognitiveBudgetExceededError, type CognitiveBudgetLedger } from "@away_from/pth-kernel-execution";
import { assertVerifiedTaskReadScope, type VerifiedTaskReadScope } from "./authorization/verified-task-read-scope.js";

export const INDEX_LOCATOR_KINDS = ["heading", "symbol", "line-range", "json-pointer"] as const;

export type IndexLocatorKind = (typeof INDEX_LOCATOR_KINDS)[number];

export interface IndexMemoryLocator {
  readonly kind: IndexLocatorKind;
  readonly value: string;
}

/** 设计 `docs/pth/design/n32-v13-professional-computing-design.md` §5.1 最小记录。 */
export interface IndexMemoryRecord {
  readonly entryId: string;
  readonly sourceId: string;
  readonly product: string;
  readonly version: string;
  readonly releaseChannel: "stable";
  readonly canonicalUri: string;
  readonly artifactHash: string;
  readonly locator: IndexMemoryLocator;
  readonly domains: readonly string[];
  readonly license: string;
}

/** backing adapter 返回的一个精确引用 span（绝不返回整份语料）。 */
export interface IndexMemorySpan {
  readonly locator: IndexMemoryLocator;
  readonly artifactHash: string;
  readonly content: string;
  /** 数据面租户/空间/状态（可选）：与已验证 scope 不符时 fail-closed。 */
  readonly tenantId?: string;
  readonly space?: string;
  readonly status?: string;
}

export interface IndexMemorySourceAdapter {
  /** 只读取记录指定的精确 locator span；实现不得提供整份语料读取。 */
  readExactSpan(record: IndexMemoryRecord, scope: { tenantId: string; space: string }): Promise<IndexMemorySpan>;
}

export interface IndexMemoryReader {
  readExact(
    scope: VerifiedTaskReadScope,
    record: IndexMemoryRecord,
    adapter: IndexMemorySourceAdapter,
    ledger: CognitiveBudgetLedger,
  ): Promise<IndexMemorySpan>;
}

const BODY_SHAPED_FIELDS = new Set(["content", "body", "text", "corpus", "fullText", "excerpt"]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isIndexLocatorKind(v: unknown): v is IndexLocatorKind {
  return typeof v === "string" && (INDEX_LOCATOR_KINDS as readonly string[]).includes(v);
}

/** Index Memory 记录校验：拒绝正文形状字段、非 stable、空 hash、未知 locator kind、缺 license/domains。 */
export function validateIndexMemoryRecord(value: unknown): IndexMemoryRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error("index memory record: object required");
  }
  const record = value as Record<string, unknown>;
  for (const field of BODY_SHAPED_FIELDS) {
    if (field in record) {
      throw new Error(`index memory record: body-shaped field "${field}" not allowed（Index Memory 只存导航元数据）`);
    }
  }
  if (!isNonEmptyString(record.entryId)) throw new Error("index memory record: entryId required");
  if (!isNonEmptyString(record.sourceId)) throw new Error("index memory record: sourceId required");
  if (!isNonEmptyString(record.product)) throw new Error("index memory record: product required");
  if (!isNonEmptyString(record.version)) throw new Error("index memory record: version required");
  if (record.releaseChannel !== "stable") throw new Error("index memory record: releaseChannel must be stable");
  if (!isNonEmptyString(record.canonicalUri)) throw new Error("index memory record: canonicalUri required");
  if (!isNonEmptyString(record.artifactHash)) throw new Error("index memory record: artifact hash required");
  if (typeof record.locator !== "object" || record.locator === null) {
    throw new Error("index memory record: locator required");
  }
  const locator = record.locator as Record<string, unknown>;
  if (!isIndexLocatorKind(locator.kind)) {
    throw new Error(`index memory record: unknown locator kind "${String(locator.kind)}"`);
  }
  if (!isNonEmptyString(locator.value)) throw new Error("index memory record: locator.value required");
  if (!Array.isArray(record.domains) || record.domains.length === 0 || !record.domains.every((d) => isNonEmptyString(d))) {
    throw new Error("index memory record: domains required（非空字符串数组）");
  }
  if (!isNonEmptyString(record.license)) throw new Error("index memory record: license required");

  return Object.freeze({
    entryId: record.entryId as string,
    sourceId: record.sourceId as string,
    product: record.product as string,
    version: record.version as string,
    releaseChannel: "stable" as const,
    canonicalUri: record.canonicalUri as string,
    artifactHash: record.artifactHash as string,
    locator: Object.freeze({ kind: locator.kind as IndexLocatorKind, value: locator.value as string }),
    domains: Object.freeze([...(record.domains as unknown[])]) as readonly string[],
    license: record.license as string,
  });
}

function spanField(span: IndexMemorySpan, field: "tenantId" | "space" | "status" | "artifactHash" | "content" | "locator"): unknown {
  return (span as unknown as Record<string, unknown>)[field];
}

export function createIndexMemoryReader(deps: { clock: () => Date }): IndexMemoryReader {
  return {
    async readExact(scope, record, adapter, ledger) {
      const validated = validateIndexMemoryRecord(record);
      // 1) 先授权：branded scope + deadline + memory.read 能力（不重放 verify）。
      assertVerifiedTaskReadScope(scope, { capabilities: ["memory.read"] }, { clock: deps.clock });

      // 2) 授权通过后才调用 backing adapter——绝不先读后授权。
      const span = await adapter.readExactSpan(validated, { tenantId: scope.tenantId, space: scope.space });
      if (typeof span !== "object" || span === null) {
        throw new Error("index memory read: adapter returned no span");
      }

      // 3) tenant/space/status/hash/locator 同一性校验——任何不匹配都 fail-closed。
      const spanTenantId = spanField(span, "tenantId");
      if (spanTenantId !== undefined && spanTenantId !== scope.tenantId) {
        throw new Error(`index memory read: tenant mismatch（span=${String(spanTenantId)}, scope=${scope.tenantId}）`);
      }
      const spanSpace = spanField(span, "space");
      if (spanSpace !== undefined && spanSpace !== scope.space) {
        throw new Error(`index memory read: space mismatch（span=${String(spanSpace)}, scope=${scope.space}）`);
      }
      const spanStatus = spanField(span, "status");
      if (spanStatus !== undefined && spanStatus !== "official") {
        throw new Error(`index memory read: span status not official（${String(spanStatus)}）`);
      }
      if (spanField(span, "artifactHash") !== validated.artifactHash) {
        throw new Error("index memory read: artifact hash mismatch");
      }
      const spanLocator = spanField(span, "locator") as IndexMemoryLocator | undefined;
      if (!spanLocator || spanLocator.kind !== validated.locator.kind || spanLocator.value !== validated.locator.value) {
        throw new Error("index memory read: locator identity mismatch（未命中精确 locator，不得退化为整份语料）");
      }
      if (typeof spanField(span, "content") !== "string") {
        throw new Error("index memory read: span content must be a string");
      }

      // 4) 按返回 span 的实际字符数走同一 CognitiveBudgetLedger 计费。
      const chars = canonicalExposureChars(span);
      const admitted = ledger.admitMemory([{ id: validated.entryId, chars }]);
      if (admitted.accepted.length === 0) {
        throw new CognitiveBudgetExceededError("memoryChars", ledger.snapshot().usage.memoryChars, chars);
      }
      return span;
    },
  };
}
