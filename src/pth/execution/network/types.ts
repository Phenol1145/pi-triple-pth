/**
 * execution/network/types.ts — TCE 网络 V1 Execute 层内部类型。
 *
 * 这些类型描述 Execute 层如何接入 provider / artifact / extractor / trace；
 * wire contracts 仍然以 `@away_from/pth-contracts` 的 V1 类型为准。
 */

import type {
  ArtifactRefV1,
  ArtifactRetentionClassV1,
  NetworkOperationProfileIdV1,
  ProviderAttemptV1,
  SearchHitV1,
} from "@away_from/pth-contracts";

/** SearchProvider 一次成功/空结果的返回面。 */
export interface ProviderSearchOutcome {
  readonly hits: readonly SearchHitV1[];
  readonly nextCursor?: string;
  /** 由 provider 自己填写的 attempt 元数据（status/resultCount/耗时等）。 */
  readonly attempt: ProviderAttemptV1;
}

/** Execute 层 SearchProvider adapter 契约（provider-neutral）。 */
export interface SearchProvider {
  readonly providerId: string;
  readonly implementationId: string;
  readonly version: string;
  readonly supportedProfiles: readonly NetworkOperationProfileIdV1[];
  readonly capabilities: {
    readonly rawHits: boolean;
    readonly cursor: boolean;
  };
  search(request: import("@away_from/pth-contracts").SearchRequestV1, ctx: import("@away_from/pth-contracts").NetworkOperationContextV1): Promise<ProviderSearchOutcome>;
}

/** Provider 可判别失败（gateway 会转成 ProviderAttemptV1 + 结构化错误）。 */
export type NetworkProviderErrorCodeV1 =
  | "NET_RATE_LIMITED"
  | "NET_PROVIDER_AUTH"
  | "NET_PROVIDER_UNAVAILABLE"
  | "NET_POLICY_DENIED"
  | "NET_TIMEOUT"
  | "NET_UNSUPPORTED_MEDIA";

export class NetworkProviderError extends Error {
  readonly code: NetworkProviderErrorCodeV1;
  constructor(code: NetworkProviderErrorCodeV1, message: string) {
    super(message);
    this.name = "NetworkProviderError";
    this.code = code;
  }
}

/** ArtifactStore 存储条目。 */
export interface StoredArtifact {
  readonly ref: ArtifactRefV1;
  readonly bytes: Uint8Array;
}

export interface ArtifactStorePutInput {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly retentionClass?: ArtifactRetentionClassV1;
  readonly sourceUrl?: string;
}

export interface ArtifactStore {
  put(input: ArtifactStorePutInput): Promise<ArtifactRefV1>;
  get(ref: ArtifactRefV1): Promise<StoredArtifact>;
}

/** 结构化 trace 条目（V1 最小面：operation 级 + attempts）。 */
export type NetworkTraceKindV1 = "search" | "fetch" | "extract";

export interface NetworkTraceEntryV1 {
  readonly operationId: string;
  readonly kind: NetworkTraceKindV1;
  readonly profileId: NetworkOperationProfileIdV1;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly attempts?: readonly ProviderAttemptV1[];
  readonly artifactId?: string;
  readonly finalUrl?: string;
}

export interface NetworkTraceRecorder {
  record(entry: NetworkTraceEntryV1): void;
}
