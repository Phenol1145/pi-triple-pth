/**
 * execution/network/gateway.ts — NetworkExecuteGateway（TCE Wave 2 Execute 底座）。
 *
 * 实现 `NetworkExecuteClient`，统一执行：
 *  - OperationPolicy / Budget / ProviderRegistry；
 *  - net.search：raw-hit provider 路由 + attempts/fallback；
 *  - net.fetch：SafeHttpTransport ownership + ArtifactStore；
 *  - net.extract：离线 deterministic extractor；
 *  - 结构化 trace。
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  ExtractedDocumentV1,
  ExtractRequestV1,
  FetchRequestV1,
  FetchResponseV1,
  NetworkOperationContextV1,
  ProviderAttemptV1,
  SearchHitV1,
  SearchRequestV1,
  SearchResponseV1,
  SearchStopReasonV1,
} from "@away_from/pth-contracts";
import type { NetworkExecuteClient } from "@away_from/pth-kernel-execution";
import type { NetworkBudget } from "./budget.js";
import { DefaultNetworkBudget } from "./budget.js";
import { createNetworkExecuteError, NetworkExecuteError } from "./errors.js";
import { DefaultOperationPolicy, type OperationPolicy } from "./operation-policy.js";
import { DefaultProviderRegistry, type ProviderRegistry } from "./provider-registry.js";
import { secureWebFetch, WebTransportError } from "./safe-http-transport.js";
import type { NetworkTraceEntryV1, NetworkTraceRecorder } from "./types.js";
import { createNoopNetworkTraceRecorder } from "./trace.js";
import { NoopNetworkObservability, type NetworkObservability } from "./observability.js";
import type { ArtifactStore } from "./types.js";
import type { OfflineHtmlExtractor } from "./extractors/offline-html.js";
import { NetworkProviderError } from "./types.js";
import { redactSensitiveQuery } from "./redaction.js";

export interface NetworkExecuteGatewayDeps {
  readonly registry?: ProviderRegistry;
  readonly policy?: OperationPolicy;
  readonly budget?: NetworkBudget;
  readonly artifactStore: ArtifactStore;
  readonly extractor: Pick<OfflineHtmlExtractor, "extract">;
  readonly traceRecorder?: NetworkTraceRecorder;
  /** Wave 4：结构化观测聚合（缺省 no-op）。 */
  readonly observability?: import("./observability.js").NetworkObservability;
  /** 测试/装配注入；缺省走 SafeHttpTransport。 */
  readonly fetchTransport?: typeof secureWebFetch;
  /** 固定任务上下文（taskId/roleId/tenantId）；operationId 与 profileId 由 gateway 填充。 */
  readonly defaultContext?: Partial<Omit<NetworkOperationContextV1, "operationId" | "profileId">>;
  readonly now?: () => Date;
  readonly createOperationId?: () => string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function mapTransportError(err: unknown, operationId: string): NetworkExecuteError {
  if (err instanceof NetworkExecuteError) return err;
  if (err instanceof WebTransportError) {
    switch (err.code) {
      case "private-address":
        return createNetworkExecuteError("NET_PRIVATE_ADDRESS", err.message, { operationId });
      case "protocol-not-allowed":
        return createNetworkExecuteError("NET_POLICY_DENIED", err.message, { operationId });
      case "too-large":
        return createNetworkExecuteError("NET_SIZE_LIMIT", err.message, { operationId });
      case "too-many-redirects":
        return createNetworkExecuteError("NET_REDIRECT_DENIED", err.message, { operationId });
      case "dns-empty":
      case "unexpected-status":
        return createNetworkExecuteError("NET_PROVIDER_UNAVAILABLE", err.message, { operationId });
    }
  }
  if (err instanceof Error && err.name === "AbortError") {
    return createNetworkExecuteError("NET_TIMEOUT", `net.fetch: 请求超时或已取消（${operationId}）`, { operationId });
  }
  const message = err instanceof Error ? err.message : String(err);
  return createNetworkExecuteError("NET_PROVIDER_UNAVAILABLE", `net.fetch: ${message}`, { operationId });
}

export class NetworkExecuteGateway implements NetworkExecuteClient {
  private readonly registry: ProviderRegistry;
  private readonly policy: OperationPolicy;
  private readonly budget: NetworkBudget;
  private readonly artifactStore: ArtifactStore;
  private readonly extractor: Pick<OfflineHtmlExtractor, "extract">;
  private readonly traceRecorder: NetworkTraceRecorder;
  private readonly observability: NetworkObservability;
  private readonly fetchTransport: typeof secureWebFetch;
  private readonly defaultContext: Partial<Omit<NetworkOperationContextV1, "operationId" | "profileId">>;
  private readonly now: () => Date;
  private readonly createOperationId: () => string;

  constructor(deps: NetworkExecuteGatewayDeps) {
    this.registry = deps.registry ?? new DefaultProviderRegistry();
    this.policy = deps.policy ?? new DefaultOperationPolicy();
    this.budget = deps.budget ?? new DefaultNetworkBudget();
    this.artifactStore = deps.artifactStore;
    this.extractor = deps.extractor;
    this.traceRecorder = deps.traceRecorder ?? createNoopNetworkTraceRecorder();
    this.observability = deps.observability ?? new NoopNetworkObservability();
    this.fetchTransport = deps.fetchTransport ?? secureWebFetch;
    this.defaultContext = deps.defaultContext ?? {};
    this.now = deps.now ?? (() => new Date());
    this.createOperationId = deps.createOperationId ?? (() => `net-${randomUUID()}`);
  }

  async search(request: SearchRequestV1): Promise<SearchResponseV1> {
    const ctx = this.buildContext("search");
    const startedAt = this.now();
    const startMs = Date.now();
    const attempts: ProviderAttemptV1[] = [];
    const hits: SearchHitV1[] = [];
    let stopReason: SearchStopReasonV1 = "provider-exhausted";
    let ok = true;
    let errorCode: string | undefined;
    try {
      this.policy.assertSearchRequest(request, ctx);
      const limit = request.limit ?? 10;
      const providers = this.registry.resolveForSearch(request, ctx);
      if (providers.length === 0) {
        throw createNetworkExecuteError("NET_PROVIDER_UNAVAILABLE", "net.search: 没有可用的 raw-hit provider", { operationId: ctx.operationId });
      }
      let lastError: NetworkExecuteError | undefined;
      for (const provider of providers) {
        try {
          const outcome = await provider.search(request, ctx);
          attempts.push(outcome.attempt);
          const accepted = outcome.hits.slice(0, Math.max(0, limit - hits.length));
          if (!this.budget.tryConsumeSearchHits(accepted.length)) {
            stopReason = "budget";
            break;
          }
          hits.push(...accepted);
          if (hits.length >= limit) {
            stopReason = "limit";
            break;
          }
          if (outcome.nextCursor) {
            stopReason = "limit";
            break;
          }
        } catch (err) {
          const code = err instanceof NetworkProviderError ? err.code : err instanceof NetworkExecuteError ? err.networkError.code : "NET_PROVIDER_UNAVAILABLE";
          const message = err instanceof Error ? err.message : String(err);
          attempts.push({
            providerId: provider.providerId,
            implementationId: provider.implementationId,
            startedAt: startedAt.toISOString(),
            durationMs: Date.now() - startMs,
            status: code === "NET_RATE_LIMITED" ? "rate-limited" : code === "NET_POLICY_DENIED" ? "skipped-policy" : "failed",
            resultCount: 0,
            errorCode: code,
          });
          if (err instanceof NetworkExecuteError) lastError = err;
          else lastError = createNetworkExecuteError(code as never, message, { operationId: ctx.operationId });
        }
      }
      if (hits.length === 0 && attempts.length > 0 && attempts.every((a) => a.status !== "ok" && a.status !== "empty")) {
        throw lastError ?? createNetworkExecuteError("NET_PROVIDER_UNAVAILABLE", "net.search: 所有 provider 失败", { operationId: ctx.operationId });
      }
      const partial = ["budget", "policy", "timeout"].includes(stopReason) || (hits.length > 0 && hits.length < limit && attempts.some((a) => a.status === "failed" || a.status === "rate-limited"));
      const response: SearchResponseV1 = {
        schemaVersion: "net.search.response/v1",
        operationId: ctx.operationId,
        queryDigest: `sha256:${this.sha256(request.query)}`,
        hits,
        attempts,
        partial,
        stopReason,
      };
      return response;
    } catch (err) {
      ok = false;
      errorCode = err instanceof NetworkExecuteError ? err.networkError.code : err instanceof NetworkProviderError ? err.code : "NET_PROVIDER_UNAVAILABLE";
      throw err;
    } finally {
      this.recordTrace({
        operationId: ctx.operationId,
        kind: "search",
        profileId: ctx.profileId,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startMs,
        ok,
        attempts,
        providerIds: [...new Set(attempts.map((a) => a.providerId))],
        publisherOrigins: [...new Set(hits.map((h) => h.publisher.origin))],
        billableUnits: attempts.reduce((sum, a) => sum + (a.billableUnits ?? 0), 0),
        queryRedacted: redactSensitiveQuery(request.query),
        ...(errorCode ? { errorCode } : {}),
      }, ctx);
    }
  }

  async fetch(request: FetchRequestV1): Promise<FetchResponseV1> {
    const ctx = this.buildContext("fetch");
    const startedAt = this.now();
    const startMs = Date.now();
    try {
      this.policy.assertFetchRequest(request, ctx);
      const result = await this.fetchTransport(request.url, {
        allowedProtocols: ["https:"],
        maxBytes: request.maxBytes ?? this.policyMaxFetchBytes(),
        timeoutMs: request.timeoutMs ?? 30_000,
        maxRedirects: 5,
        label: "net.fetch",
        ...(request.conditional?.etag ? { headers: { "if-none-match": request.conditional.etag } } : {}),
        ...(request.conditional?.lastModified ? { headers: { "if-modified-since": request.conditional.lastModified } } : {}),
      });
      if (!this.budget.tryConsumeFetchBytes(result.byteLength)) {
        throw createNetworkExecuteError("NET_SIZE_LIMIT", `net.fetch: 超过任务 fetch 预算（${result.byteLength} bytes）`, { operationId: ctx.operationId });
      }
      const ref = await this.artifactStore.put({
        bytes: result.rawBytes,
        mediaType: result.headers["content-type"]?.split(";")[0]?.trim() ?? "application/octet-stream",
        retentionClass: "task",
        sourceUrl: result.finalUri,
      });
      const response: FetchResponseV1 = {
        schemaVersion: "net.fetch.response/v1",
        operationId: ctx.operationId,
        requestedUrl: request.url,
        finalUrl: result.finalUri,
        redirectChain: result.redirectChain,
        retrievedAt: startedAt.toISOString(),
        status: result.status,
        headers: {
          ...(result.headers["content-type"] ? { contentType: result.headers["content-type"] } : {}),
          ...(result.headers["content-length"] ? { contentLength: Number(result.headers["content-length"]) } : {}),
          ...(result.headers["etag"] ? { etag: result.headers["etag"] } : {}),
          ...(result.headers["last-modified"] ? { lastModified: result.headers["last-modified"] } : {}),
        },
        artifact: { ref },
        transport: {
          policyVersion: "v1",
          bytesRead: result.byteLength,
          truncated: false,
        },
      };
      this.recordTrace({
        operationId: ctx.operationId,
        kind: "fetch",
        profileId: ctx.profileId,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startMs,
        ok: true,
        artifactId: ref.artifactId,
        finalUrl: result.finalUri,
        bytesRead: result.byteLength,
      }, ctx);
      return response;
    } catch (err) {
      const mapped = mapTransportError(err, ctx.operationId);
      this.recordTrace({
        operationId: ctx.operationId,
        kind: "fetch",
        profileId: ctx.profileId,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startMs,
        ok: false,
        errorCode: mapped.networkError.code,
      }, ctx);
      throw mapped;
    }
  }

  async extract(request: ExtractRequestV1): Promise<ExtractedDocumentV1> {
    const ctx = this.buildContext("extract");
    const startedAt = this.now();
    const startMs = Date.now();
    try {
      this.policy.assertExtractRequest(request, ctx);
      const doc = await this.extractor.extract(request, this.artifactStore);
      const outputChars = doc.text?.length ?? 0;
      if (!this.budget.tryConsumeExtractOutputChars(outputChars)) {
        throw createNetworkExecuteError("NET_SIZE_LIMIT", `net.extract: 超过任务 extract 输出预算（${outputChars} chars）`, { operationId: ctx.operationId });
      }
      this.recordTrace({
        operationId: ctx.operationId,
        kind: "extract",
        profileId: ctx.profileId,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startMs,
        ok: true,
        artifactId: request.artifactRef.artifactId,
        processorIds: [...new Set(doc.processingChain.map((p) => p.processorId))],
      }, ctx);
      return doc;
    } catch (err) {
      const mapped = err instanceof NetworkExecuteError ? err : createNetworkExecuteError("NET_ARTIFACT_MISMATCH", err instanceof Error ? err.message : String(err), { operationId: ctx.operationId });
      this.recordTrace({
        operationId: ctx.operationId,
        kind: "extract",
        profileId: ctx.profileId,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startMs,
        ok: false,
        errorCode: mapped.networkError.code,
        artifactId: request.artifactRef.artifactId,
      }, ctx);
      throw mapped;
    }
  }

  async fetchText(
    url: string,
    opts: { maxBytes?: number; timeoutMs?: number } = {},
    context?: NetworkOperationContextV1,
  ): Promise<string> {
    const ctx = context ?? this.buildContext("fetch");
    const startedAt = this.now();
    const startMs = Date.now();
    try {
      const result = await this.fetchTransport(url, {
        // legacy web.fetchText 保留 HTTP/HTTPS-compatible；新 net.fetch 仍 HTTPS-only。
        allowedProtocols: ["http:", "https:"],
        maxBytes: opts.maxBytes ?? this.policyMaxFetchBytes(),
        timeoutMs: opts.timeoutMs ?? 30_000,
        maxRedirects: 5,
        label: "web.fetchText",
      });
      const text = new TextDecoder().decode(result.rawBytes);
      const ctype = result.headers["content-type"] ?? "";
      const output = /html/i.test(ctype) ? stripHtml(text) : text;
      this.recordTrace({
        operationId: ctx.operationId,
        kind: "fetchText",
        profileId: ctx.profileId,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startMs,
        ok: true,
        finalUrl: result.finalUri,
        bytesRead: result.byteLength,
      }, ctx);
      return output;
    } catch (err) {
      const mapped = mapTransportError(err, ctx.operationId);
      this.recordTrace({
        operationId: ctx.operationId,
        kind: "fetchText",
        profileId: ctx.profileId,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startMs,
        ok: false,
        errorCode: mapped.networkError.code,
      }, ctx);
      throw mapped;
    }
  }

  private recordTrace(entry: NetworkTraceEntryV1, ctx?: NetworkOperationContextV1): void {
    const full: NetworkTraceEntryV1 = {
      ...entry,
      ...(ctx?.taskId ? { taskId: ctx.taskId } : {}),
      ...(ctx?.tenantId ? { tenantId: ctx.tenantId } : {}),
      ...(ctx?.roleId ? { roleId: ctx.roleId } : {}),
    };
    this.traceRecorder.record(full);
    this.observability.record(full);
  }

  private buildContext(kind: "search" | "fetch" | "extract"): NetworkOperationContextV1 {
    return {
      operationId: this.createOperationId(),
      profileId: this.policy.profileId,
      ...this.defaultContext,
    };
  }

  private policyMaxFetchBytes(): number {
    // OperationPolicy 暴露上限；这里读取默认 1MB（与 SafeHttpTransport 默认一致）。
    return 1024 * 1024;
  }

  private sha256(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }
}
