/**
 * contracts/network-information.ts — PTH 网络信息基础设施 V1 wire contracts。
 *
 * 对应 V1 架构报告 §7（Search / Fetch / Extract / Artifact / Trace / Error）。
 * 本层只包含纯类型与结构校验，不 import 任何运行时实现。
 */

// ─── Schema versions ────────────────────────────────────────────────

export const NETWORK_SCHEMA_VERSIONS = {
  searchRequest: "net.search.request/v1",
  searchResponse: "net.search.response/v1",
  fetchRequest: "net.fetch.request/v1",
  fetchResponse: "net.fetch.response/v1",
  extractRequest: "net.extract.request/v1",
  document: "net.document/v1",
} as const;

export type NetworkSchemaVersion = (typeof NETWORK_SCHEMA_VERSIONS)[keyof typeof NETWORK_SCHEMA_VERSIONS];

// ─── Search ─────────────────────────────────────────────────────────

export interface SearchRequestV1 {
  readonly schemaVersion: "net.search.request/v1";
  readonly query: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly language?: string;
  readonly timeRange?: { readonly from?: string; readonly to?: string };
  readonly siteAllowlist?: readonly string[];
  readonly siteDenylist?: readonly string[];
  readonly sourceKinds?: readonly string[];
}

export interface SearchHitV1 {
  readonly rank: number;
  readonly title: string;
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly snippet?: string;
  readonly publishedAt?: string;
  readonly language?: string;
  readonly mediaType?: string;
  readonly discovery: {
    readonly providerId: string;
    readonly providerVersion: string;
    readonly providerRank?: number;
    readonly retrievedAt: string;
  };
  readonly publisher: {
    readonly origin: string;
    readonly identityId?: string;
    readonly sourceKindHint?: string;
  };
  readonly trust: "public-untrusted";
}

export interface ProviderAttemptV1 {
  readonly providerId: string;
  readonly implementationId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly status: "ok" | "empty" | "rate-limited" | "failed" | "skipped-policy";
  readonly resultCount: number;
  readonly billableUnits?: number;
  readonly errorCode?: string;
}

export type SearchStopReasonV1 = "limit" | "provider-exhausted" | "budget" | "policy" | "timeout";

export interface SearchResponseV1 {
  readonly schemaVersion: "net.search.response/v1";
  readonly operationId: string;
  readonly queryDigest: string;
  readonly hits: readonly SearchHitV1[];
  readonly attempts: readonly ProviderAttemptV1[];
  readonly nextCursor?: string;
  readonly partial: boolean;
  readonly stopReason: SearchStopReasonV1;
}

// ─── Fetch / Artifact ───────────────────────────────────────────────

export interface FetchRequestV1 {
  readonly schemaVersion: "net.fetch.request/v1";
  readonly url: string;
  readonly accept?: readonly string[];
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly conditional?: { readonly etag?: string; readonly lastModified?: string };
}

export type ArtifactStorageKindV1 = "inline-pg" | "task-artifact" | "object";
export type ArtifactRetentionClassV1 = "ephemeral" | "task" | "intake-durable";

export interface ArtifactRefV1 {
  readonly artifactId: string;
  readonly storageKind: ArtifactStorageKindV1;
  readonly immutableLocator: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly retentionClass: ArtifactRetentionClassV1;
}

export interface FetchResponseV1 {
  readonly schemaVersion: "net.fetch.response/v1";
  readonly operationId: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly retrievedAt: string;
  readonly status: number;
  readonly headers: {
    readonly contentType?: string;
    readonly contentLength?: number;
    readonly etag?: string;
    readonly lastModified?: string;
  };
  readonly artifact: { readonly ref: ArtifactRefV1 };
  readonly transport: {
    readonly policyVersion: string;
    readonly bytesRead: number;
    readonly truncated: false;
  };
}

// ─── Extract / Document ─────────────────────────────────────────────

export type ExtractModeV1 = "main-content" | "metadata" | "links" | "structured";

export interface ExtractRequestV1 {
  readonly schemaVersion: "net.extract.request/v1";
  readonly artifactRef: ArtifactRefV1;
  readonly mode: ExtractModeV1;
  readonly maxOutputChars?: number;
}

export interface ExtractedDocumentV1 {
  readonly schemaVersion: "net.document/v1";
  readonly sourceArtifact: ArtifactRefV1;
  readonly title?: string;
  readonly canonicalUrl?: string;
  readonly author?: string;
  readonly publishedAt?: string;
  readonly language?: string;
  readonly text?: string;
  readonly sections?: readonly { readonly headingPath: readonly string[]; readonly text: string }[];
  readonly links?: readonly { readonly url: string; readonly text?: string; readonly relation?: string }[];
  readonly processingChain: readonly {
    readonly processorId: string;
    readonly processorVersion: string;
    readonly implementationLanguage: string;
    readonly inputHash: string;
    readonly outputHash: string;
  }[];
  readonly warnings: readonly string[];
  readonly trust: "processed-untrusted";
}

// ─── Operation context / structured errors ─────────────────────────

export type NetworkOperationProfileIdV1 = "search-public" | "research-public" | (string & {});

export interface NetworkOperationContextV1 {
  readonly operationId: string;
  readonly taskId?: string;
  readonly roleId?: string;
  readonly tenantId?: string;
  readonly profileId: NetworkOperationProfileIdV1;
}

export const NETWORK_ERROR_CODES = [
  "NET_CAPABILITY_DENIED",
  "NET_POLICY_DENIED",
  "NET_PRIVATE_ADDRESS",
  "NET_REDIRECT_DENIED",
  "NET_SIZE_LIMIT",
  "NET_TIMEOUT",
  "NET_RATE_LIMITED",
  "NET_PROVIDER_AUTH",
  "NET_PROVIDER_UNAVAILABLE",
  "NET_UNSUPPORTED_MEDIA",
  "NET_ARTIFACT_MISMATCH",
  "NET_PARTIAL",
] as const;

export type NetworkErrorCodeV1 = (typeof NETWORK_ERROR_CODES)[number] | (string & {});

export interface NetworkErrorV1 {
  readonly code: NetworkErrorCodeV1;
  readonly message: string;
  readonly operationId?: string;
  readonly attempt?: ProviderAttemptV1;
}

// ─── Structural validators（fail-closed；纯函数） ──────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function isOptionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

function isOptionalNonNegativeFiniteNumber(v: unknown): v is number | undefined {
  return v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isIsoDateString(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

export function isSearchRequestV1(v: unknown): v is SearchRequestV1 {
  if (!isRecord(v)) return false;
  if (v.schemaVersion !== NETWORK_SCHEMA_VERSIONS.searchRequest || !isNonEmptyString(v.query)) return false;
  if (v.limit !== undefined && (typeof v.limit !== "number" || !Number.isFinite(v.limit) || v.limit <= 0)) return false;
  if (!isOptionalString(v.cursor) || !isOptionalString(v.language)) return false;
  if (v.timeRange !== undefined) {
    if (!isRecord(v.timeRange)) return false;
    if (!isOptionalString(v.timeRange.from) || !isOptionalString(v.timeRange.to)) return false;
  }
  if (v.siteAllowlist !== undefined && !isStringArray(v.siteAllowlist)) return false;
  if (v.siteDenylist !== undefined && !isStringArray(v.siteDenylist)) return false;
  if (v.sourceKinds !== undefined && !isStringArray(v.sourceKinds)) return false;
  return true;
}

export function isProviderAttemptV1(v: unknown): v is ProviderAttemptV1 {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.providerId) || !isNonEmptyString(v.implementationId)) return false;
  if (!isIsoDateString(v.startedAt)) return false;
  if (typeof v.durationMs !== "number" || !Number.isFinite(v.durationMs) || v.durationMs < 0) return false;
  if (!["ok", "empty", "rate-limited", "failed", "skipped-policy"].includes(String(v.status))) return false;
  if (typeof v.resultCount !== "number" || !Number.isFinite(v.resultCount) || v.resultCount < 0) return false;
  if (!isOptionalNonNegativeFiniteNumber(v.billableUnits)) return false;
  return isOptionalString(v.errorCode);
}

export function isSearchHitV1(v: unknown): v is SearchHitV1 {
  if (!isRecord(v)) return false;
  if (typeof v.rank !== "number" || !Number.isFinite(v.rank) || v.rank < 0) return false;
  if (!isNonEmptyString(v.title) || !isNonEmptyString(v.url)) return false;
  if (!isOptionalString(v.canonicalUrl) || !isOptionalString(v.snippet) || !isOptionalString(v.publishedAt)) return false;
  if (!isOptionalString(v.language) || !isOptionalString(v.mediaType)) return false;
  if (!isRecord(v.discovery) || !isNonEmptyString(v.discovery.providerId) || !isNonEmptyString(v.discovery.providerVersion) || !isIsoDateString(v.discovery.retrievedAt)) return false;
  if (v.discovery.providerRank !== undefined && (typeof v.discovery.providerRank !== "number" || !Number.isFinite(v.discovery.providerRank) || v.discovery.providerRank < 0)) return false;
  if (!isRecord(v.publisher) || !isNonEmptyString(v.publisher.origin)) return false;
  if (!isOptionalString(v.publisher.identityId) || !isOptionalString(v.publisher.sourceKindHint)) return false;
  return v.trust === "public-untrusted";
}

export function isSearchResponseV1(v: unknown): v is SearchResponseV1 {
  if (!isRecord(v)) return false;
  if (v.schemaVersion !== NETWORK_SCHEMA_VERSIONS.searchResponse || !isNonEmptyString(v.operationId) || !isNonEmptyString(v.queryDigest)) return false;
  if (!Array.isArray(v.hits) || !v.hits.every(isSearchHitV1)) return false;
  if (!Array.isArray(v.attempts) || !v.attempts.every(isProviderAttemptV1)) return false;
  if (!isOptionalString(v.nextCursor)) return false;
  if (typeof v.partial !== "boolean") return false;
  if (!["limit", "provider-exhausted", "budget", "policy", "timeout"].includes(String(v.stopReason))) return false;
  return true;
}

export function isArtifactRefV1(v: unknown): v is ArtifactRefV1 {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.artifactId) || !isNonEmptyString(v.immutableLocator) || !isNonEmptyString(v.sha256)) return false;
  if (!["inline-pg", "task-artifact", "object"].includes(String(v.storageKind))) return false;
  if (typeof v.byteLength !== "number" || !Number.isFinite(v.byteLength) || v.byteLength < 0) return false;
  if (!isNonEmptyString(v.mediaType)) return false;
  if (!["ephemeral", "task", "intake-durable"].includes(String(v.retentionClass))) return false;
  return true;
}

export function isFetchRequestV1(v: unknown): v is FetchRequestV1 {
  if (!isRecord(v)) return false;
  if (v.schemaVersion !== NETWORK_SCHEMA_VERSIONS.fetchRequest || !isNonEmptyString(v.url)) return false;
  if (v.accept !== undefined && !isStringArray(v.accept)) return false;
  if (!isOptionalNonNegativeFiniteNumber(v.maxBytes) || !isOptionalNonNegativeFiniteNumber(v.timeoutMs)) return false;
  if (v.conditional !== undefined) {
    if (!isRecord(v.conditional)) return false;
    if (!isOptionalString(v.conditional.etag) || !isOptionalString(v.conditional.lastModified)) return false;
  }
  return true;
}

export function isFetchResponseV1(v: unknown): v is FetchResponseV1 {
  if (!isRecord(v)) return false;
  if (v.schemaVersion !== NETWORK_SCHEMA_VERSIONS.fetchResponse || !isNonEmptyString(v.operationId)) return false;
  if (!isNonEmptyString(v.requestedUrl) || !isNonEmptyString(v.finalUrl)) return false;
  if (!Array.isArray(v.redirectChain) || !v.redirectChain.every((x) => typeof x === "string")) return false;
  if (!isIsoDateString(v.retrievedAt) || typeof v.status !== "number" || !Number.isFinite(v.status)) return false;
  if (!isRecord(v.headers)) return false;
  if (!isOptionalString(v.headers.contentType) || !isOptionalString(v.headers.etag) || !isOptionalString(v.headers.lastModified)) return false;
  if (v.headers.contentLength !== undefined && (typeof v.headers.contentLength !== "number" || !Number.isFinite(v.headers.contentLength) || v.headers.contentLength < 0)) return false;
  if (!isRecord(v.artifact) || !isRecord(v.artifact.ref) || !isArtifactRefV1(v.artifact.ref)) return false;
  if (!isRecord(v.transport) || !isNonEmptyString(v.transport.policyVersion) || typeof v.transport.bytesRead !== "number" || !Number.isFinite(v.transport.bytesRead) || v.transport.bytesRead < 0) return false;
  return v.transport.truncated === false;
}

export function isExtractRequestV1(v: unknown): v is ExtractRequestV1 {
  if (!isRecord(v)) return false;
  if (v.schemaVersion !== NETWORK_SCHEMA_VERSIONS.extractRequest) return false;
  if (!isRecord(v.artifactRef) || !isArtifactRefV1(v.artifactRef)) return false;
  if (!["main-content", "metadata", "links", "structured"].includes(String(v.mode))) return false;
  return isOptionalNonNegativeFiniteNumber(v.maxOutputChars);
}

export function isExtractedDocumentV1(v: unknown): v is ExtractedDocumentV1 {
  if (!isRecord(v)) return false;
  if (v.schemaVersion !== NETWORK_SCHEMA_VERSIONS.document) return false;
  if (!isRecord(v.sourceArtifact) || !isArtifactRefV1(v.sourceArtifact)) return false;
  if (!isOptionalString(v.title) || !isOptionalString(v.canonicalUrl) || !isOptionalString(v.author) || !isOptionalString(v.publishedAt) || !isOptionalString(v.language) || !isOptionalString(v.text)) return false;
  if (v.sections !== undefined) {
    if (!Array.isArray(v.sections) || !v.sections.every((s) => isRecord(s) && Array.isArray(s.headingPath) && s.headingPath.every((x) => typeof x === "string") && typeof s.text === "string")) return false;
  }
  if (v.links !== undefined) {
    if (!Array.isArray(v.links) || !v.links.every((l) => isRecord(l) && isNonEmptyString(l.url) && isOptionalString(l.text) && isOptionalString(l.relation))) return false;
  }
  if (!Array.isArray(v.processingChain) || !v.processingChain.every((p) => isRecord(p) && isNonEmptyString(p.processorId) && isNonEmptyString(p.processorVersion) && isNonEmptyString(p.implementationLanguage) && isNonEmptyString(p.inputHash) && isNonEmptyString(p.outputHash))) return false;
  if (!Array.isArray(v.warnings) || !v.warnings.every((w) => typeof w === "string")) return false;
  return v.trust === "processed-untrusted";
}

export function isNetworkOperationContextV1(v: unknown): v is NetworkOperationContextV1 {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.operationId)) return false;
  if (!isOptionalString(v.taskId) || !isOptionalString(v.roleId) || !isOptionalString(v.tenantId)) return false;
  return typeof v.profileId === "string" && v.profileId.trim() !== "";
}

export function isNetworkErrorV1(v: unknown): v is NetworkErrorV1 {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.code) || !isNonEmptyString(v.message)) return false;
  if (!isOptionalString(v.operationId)) return false;
  if (v.attempt !== undefined && !isProviderAttemptV1(v.attempt)) return false;
  return true;
}
