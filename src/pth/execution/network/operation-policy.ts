/**
 * execution/network/operation-policy.ts — Execute 层 OperationPolicy。
 *
 * V1 只启用 `search-public` profile；`research-public` 冻结但不可用。
 * 策略只做请求面边界，不触碰 socket/DNS——真实 egress 安全由 SafeHttpTransport 负责。
 */

import type {
  ExtractRequestV1,
  FetchRequestV1,
  NetworkOperationContextV1,
  SearchRequestV1,
} from "@away_from/pth-contracts";
import { createNetworkExecuteError } from "./errors.js";
import { containsSensitiveInput } from "./redaction.js";

export interface OperationPolicyOptions {
  readonly profileId?: string;
  readonly maxQueryLength?: number;
  readonly maxSearchHits?: number;
  readonly maxFetchBytes?: number;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly requireHttps?: boolean;
  readonly denyUserinfo?: boolean;
  readonly denySensitiveInput?: boolean;
  readonly allowedProtocols?: readonly string[];
}

export interface OperationPolicy {
  readonly profileId: string;
  assertSearchRequest(request: SearchRequestV1, ctx: NetworkOperationContextV1): void;
  assertFetchRequest(request: FetchRequestV1, ctx: NetworkOperationContextV1): void;
  assertExtractRequest(request: ExtractRequestV1, ctx: NetworkOperationContextV1): void;
}

const SEARCH_PUBLIC_PROFILE = "search-public";

export class DefaultOperationPolicy implements OperationPolicy {
  readonly profileId: string;
  private readonly maxQueryLength: number;
  private readonly maxSearchHits: number;
  private readonly maxFetchBytes: number;
  private readonly maxRedirects: number;
  private readonly timeoutMs: number;
  private readonly requireHttps: boolean;
  private readonly denyUserinfo: boolean;
  private readonly denySensitiveInput: boolean;
  private readonly allowedProtocols: readonly string[];

  constructor(opts: OperationPolicyOptions = {}) {
    this.profileId = opts.profileId ?? SEARCH_PUBLIC_PROFILE;
    this.maxQueryLength = opts.maxQueryLength ?? 500;
    this.maxSearchHits = opts.maxSearchHits ?? 20;
    this.maxFetchBytes = opts.maxFetchBytes ?? 1024 * 1024;
    this.maxRedirects = opts.maxRedirects ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.requireHttps = opts.requireHttps ?? true;
    this.denyUserinfo = opts.denyUserinfo ?? true;
    this.denySensitiveInput = opts.denySensitiveInput ?? true;
    this.allowedProtocols = opts.allowedProtocols ?? (this.requireHttps ? ["https:"] : ["http:", "https:"]);
  }

  assertSearchRequest(request: SearchRequestV1, ctx: NetworkOperationContextV1): void {
    this.assertProfile(ctx);
    if (request.query.trim() === "") {
      throw createNetworkExecuteError("NET_POLICY_DENIED", "net.search: query 不能为空", { operationId: ctx.operationId });
    }
    if (request.query.length > this.maxQueryLength) {
      throw createNetworkExecuteError("NET_POLICY_DENIED", `net.search: query 超过 ${this.maxQueryLength} 字符`, { operationId: ctx.operationId });
    }
    if (request.limit !== undefined && request.limit > this.maxSearchHits) {
      throw createNetworkExecuteError("NET_POLICY_DENIED", `net.search: limit 超过策略上限 ${this.maxSearchHits}`, { operationId: ctx.operationId });
    }
    if (this.denySensitiveInput && containsSensitiveInput(request.query)) {
      throw createNetworkExecuteError("NET_POLICY_DENIED", "net.search: query 含敏感键名（api_key/secret/token/password 等），已拒绝", { operationId: ctx.operationId });
    }
  }

  assertFetchRequest(request: FetchRequestV1, ctx: NetworkOperationContextV1): void {
    this.assertProfile(ctx);
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      throw createNetworkExecuteError("NET_POLICY_DENIED", "net.fetch: URL 无法解析", { operationId: ctx.operationId });
    }
    if (!this.allowedProtocols.includes(parsed.protocol)) {
      const allowed = this.allowedProtocols.length === 1 ? this.allowedProtocols[0]!.replace(":", "") : "http(s)";
      throw createNetworkExecuteError("NET_POLICY_DENIED", `net.fetch: 仅允许 ${allowed} URL`, { operationId: ctx.operationId });
    }
    if (this.denyUserinfo && (parsed.username !== "" || parsed.password !== "")) {
      throw createNetworkExecuteError("NET_POLICY_DENIED", "net.fetch: URL 不允许包含 userinfo/凭据", { operationId: ctx.operationId });
    }
    if (this.denySensitiveInput && containsSensitiveInput(parsed.search)) {
      throw createNetworkExecuteError("NET_POLICY_DENIED", "net.fetch: URL query 含敏感键名（api_key/secret/token/password 等），已拒绝", { operationId: ctx.operationId });
    }
    if (request.maxBytes !== undefined && request.maxBytes > this.maxFetchBytes) {
      throw createNetworkExecuteError("NET_POLICY_DENIED", `net.fetch: maxBytes 超过策略上限 ${this.maxFetchBytes}`, { operationId: ctx.operationId });
    }
  }

  assertExtractRequest(_request: ExtractRequestV1, ctx: NetworkOperationContextV1): void {
    this.assertProfile(ctx);
  }

  private assertProfile(ctx: NetworkOperationContextV1): void {
    if (ctx.profileId !== this.profileId) {
      throw createNetworkExecuteError(
        "NET_POLICY_DENIED",
        `profile ${ctx.profileId} 当前不可用；V1 只启用 ${this.profileId}`,
        { operationId: ctx.operationId },
      );
    }
  }
}
