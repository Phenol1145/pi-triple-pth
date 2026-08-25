import { describe, it, expect } from "vitest";
import {
  isArtifactRefV1,
  isExtractedDocumentV1,
  isExtractRequestV1,
  isFetchRequestV1,
  isFetchResponseV1,
  isNetworkErrorV1,
  isNetworkOperationContextV1,
  isProviderAttemptV1,
  isSearchHitV1,
  isSearchRequestV1,
  isSearchResponseV1,
  NETWORK_ERROR_CODES,
} from "@away_from/pth-contracts";

const artifactRef = {
  artifactId: "artifact-001",
  storageKind: "inline-pg",
  immutableLocator: "pg:sha256:abc",
  sha256: "abc",
  byteLength: 123,
  mediaType: "text/html",
  retentionClass: "task",
} as const;

describe("pth contracts: network-information V1", () => {
  it("validates SearchRequestV1", () => {
    expect(isSearchRequestV1({ schemaVersion: "net.search.request/v1", query: "rust async" })).toBe(true);
    expect(isSearchRequestV1({ schemaVersion: "net.search.request/v1", query: "x", limit: 10, siteAllowlist: ["example.com"] })).toBe(true);
    expect(isSearchRequestV1({ schemaVersion: "net.search.request/v1", query: "" })).toBe(false);
    expect(isSearchRequestV1({ schemaVersion: "net.search.request/v1", query: "x", limit: -1 })).toBe(false);
    expect(isSearchRequestV1({ query: "x" })).toBe(false);
  });

  it("validates SearchHitV1 with separated discovery/publisher", () => {
    const hit = {
      rank: 1,
      title: "Example",
      url: "https://example.com",
      discovery: { providerId: "exa", providerVersion: "1", retrievedAt: "2026-08-26T00:00:00.000Z" },
      publisher: { origin: "example.com" },
      trust: "public-untrusted",
    } as const;
    expect(isSearchHitV1(hit)).toBe(true);
    expect(isSearchHitV1({ ...hit, trust: "processed-untrusted" })).toBe(false);
    expect(isSearchHitV1({ ...hit, publisher: { origin: "" } })).toBe(false);
  });

  it("validates ProviderAttemptV1 and SearchResponseV1", () => {
    const attempt = {
      providerId: "exa",
      implementationId: "exa-v1",
      startedAt: "2026-08-26T00:00:00.000Z",
      durationMs: 12,
      status: "ok",
      resultCount: 1,
    } as const;
    expect(isProviderAttemptV1(attempt)).toBe(true);
    expect(isProviderAttemptV1({ ...attempt, status: "mystery" })).toBe(false);

    const response = {
      schemaVersion: "net.search.response/v1",
      operationId: "op-1",
      queryDigest: "sha256:q",
      hits: [],
      attempts: [attempt],
      partial: false,
      stopReason: "limit",
    } as const;
    expect(isSearchResponseV1(response)).toBe(true);
    expect(isSearchResponseV1({ ...response, stopReason: "done" })).toBe(false);
  });

  it("validates ArtifactRefV1 and FetchRequestV1/FetchResponseV1", () => {
    expect(isArtifactRefV1(artifactRef)).toBe(true);
    expect(isArtifactRefV1({ ...artifactRef, byteLength: -1 })).toBe(false);
    expect(isFetchRequestV1({ schemaVersion: "net.fetch.request/v1", url: "https://example.com" })).toBe(true);
    expect(isFetchRequestV1({ schemaVersion: "net.fetch.request/v1", url: "" })).toBe(false);

    const response = {
      schemaVersion: "net.fetch.response/v1",
      operationId: "op-2",
      requestedUrl: "https://example.com",
      finalUrl: "https://example.com/",
      redirectChain: [],
      retrievedAt: "2026-08-26T00:00:00.000Z",
      status: 200,
      headers: { contentType: "text/html" },
      artifact: { ref: artifactRef },
      transport: { policyVersion: "v1", bytesRead: 123, truncated: false },
    } as const;
    expect(isFetchResponseV1(response)).toBe(true);
    expect(isFetchResponseV1({ ...response, transport: { ...response.transport, truncated: true } })).toBe(false);
  });

  it("validates ExtractRequestV1 and ExtractedDocumentV1", () => {
    const request = { schemaVersion: "net.extract.request/v1", artifactRef, mode: "main-content" } as const;
    expect(isExtractRequestV1(request)).toBe(true);
    expect(isExtractRequestV1({ ...request, mode: "auto" })).toBe(false);

    const doc = {
      schemaVersion: "net.document/v1",
      sourceArtifact: artifactRef,
      text: "hello",
      processingChain: [{ processorId: "readability", processorVersion: "1", implementationLanguage: "ts", inputHash: "abc", outputHash: "def" }],
      warnings: [],
      trust: "processed-untrusted",
    } as const;
    expect(isExtractedDocumentV1(doc)).toBe(true);
    expect(isExtractedDocumentV1({ ...doc, trust: "public-untrusted" })).toBe(false);
  });

  it("freezes structured error codes and validates context/errors", () => {
    expect(NETWORK_ERROR_CODES).toContain("NET_PRIVATE_ADDRESS");
    expect(NETWORK_ERROR_CODES).toContain("NET_SIZE_LIMIT");
    expect(isNetworkOperationContextV1({ operationId: "op-3", profileId: "search-public" })).toBe(true);
    expect(isNetworkOperationContextV1({ operationId: "", profileId: "search-public" })).toBe(false);
    expect(isNetworkErrorV1({ code: "NET_TIMEOUT", message: "timeout" })).toBe(true);
    expect(isNetworkErrorV1({ code: "NET_TIMEOUT", message: "" })).toBe(false);
  });
});
