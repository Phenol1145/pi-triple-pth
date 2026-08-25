import { describe, it, expect } from "vitest";
import {
  DefaultOperationPolicy,
  InMemoryArtifactStore,
  InMemoryNetworkObservability,
  NetworkExecuteGateway,
  containsSensitiveInput,
  createOfflineHtmlExtractor,
  redactSensitiveQuery,
} from "../../src/pth/execution/network/index.js";
import { isSearchResponseV1, isExtractedDocumentV1 } from "@away_from/pth-contracts";
import { isIntakeEvidenceReferenceShape } from "@away_from/pth-memory";
import type { NetworkExecuteClient } from "@away_from/pth-kernel-execution";

describe("TCE Wave 4 策略/可观测/类型隔离", () => {
  it("敏感 query/URL query 被策略拒绝", async () => {
    const policy = new DefaultOperationPolicy();
    const ctx = { operationId: "op", profileId: "search-public" } as const;
    expect(() => policy.assertSearchRequest({ schemaVersion: "net.search.request/v1", query: "how to use api_key=abc" }, ctx)).toThrow(/敏感/);
    expect(() => policy.assertFetchRequest({ schemaVersion: "net.fetch.request/v1", url: "https://example.com/?token=secret" }, ctx)).toThrow(/敏感/);
    expect(containsSensitiveInput("password=123")).toBe(true);
    expect(redactSensitiveQuery("q=hello&api_key=abc")).toBe("q=hello&api_key=[REDACTED]");
  });

  it("observability 聚合调用次数/字节/失败码", async () => {
    const obs = new InMemoryNetworkObservability();
    const store = new InMemoryArtifactStore();
    const ref = await store.put({ bytes: new TextEncoder().encode("<p>x</p>"), mediaType: "text/html" });
    const gateway = new NetworkExecuteGateway({
      artifactStore: store,
      extractor: createOfflineHtmlExtractor(),
      observability: obs,
      fetchTransport: async (url) => ({
        requestedUri: url, finalUri: url, redirectChain: [url], status: 200, headers: {}, rawBytes: new Uint8Array([1, 2]), byteLength: 2, hops: [],
      }),
      createOperationId: () => "op-wave4",
    });
    await gateway.fetchText("https://example.com");
    await gateway.extract({ schemaVersion: "net.extract.request/v1", artifactRef: ref, mode: "main-content" });
    const snap = obs.snapshot();
    expect(snap.fetchTextCount).toBe(1);
    expect(snap.extractCount).toBe(1);
    expect(snap.totalBytesRead).toBe(2);
    expect(snap.failureCount).toBe(0);
  });

  it("trace 记录 provider/publisher/processor/bytes 三方身份", async () => {
    const { InMemoryNetworkTraceRecorder } = await import("../../src/pth/execution/network/index.js");
    const trace = new InMemoryNetworkTraceRecorder();
    const store = new InMemoryArtifactStore();
    const html = "<html><head><title>T</title></head><body><p>hello</p></body></html>";
    const ref = await store.put({ bytes: new TextEncoder().encode(html), mediaType: "text/html" });
    const gateway = new NetworkExecuteGateway({
      artifactStore: store,
      extractor: createOfflineHtmlExtractor(),
      traceRecorder: trace,
      fetchTransport: async (url) => ({
        requestedUri: url, finalUri: url, redirectChain: [url], status: 200, headers: {}, rawBytes: new Uint8Array([1]), byteLength: 1, hops: [],
      }),
      createOperationId: () => "op-trace-wave4",
    });
    await gateway.fetchText("https://example.com");
    await gateway.extract({ schemaVersion: "net.extract.request/v1", artifactRef: ref, mode: "main-content" });
    const fetchTrace = trace.byOperationId("op-trace-wave4");
    const extractTrace = trace.entries.find((e) => e.kind === "extract");
    expect(fetchTrace?.bytesRead).toBe(1);
    expect(extractTrace?.processorIds).toContain("offline-html");
  });

  it("Search/Extract 类型不能通过 Intake EvidenceReference 校验（类型隔离）", () => {
    const searchResponse = {
      schemaVersion: "net.search.response/v1",
      operationId: "op",
      queryDigest: "sha256:q",
      hits: [],
      attempts: [],
      partial: false,
      stopReason: "provider-exhausted",
    };
    const doc = {
      schemaVersion: "net.document/v1",
      sourceArtifact: { artifactId: "a", storageKind: "task-artifact", immutableLocator: "a", sha256: "0", byteLength: 0, mediaType: "text/plain", retentionClass: "task" },
      processingChain: [],
      warnings: [],
      trust: "processed-untrusted",
    };
    expect(isSearchResponseV1(searchResponse)).toBe(true);
    expect(isExtractedDocumentV1(doc)).toBe(true);
    expect(isIntakeEvidenceReferenceShape(searchResponse)).toBe(false);
    expect(isIntakeEvidenceReferenceShape(doc)).toBe(false);
  });
});
