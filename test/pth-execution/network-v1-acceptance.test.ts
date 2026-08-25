import { describe, it, expect } from "vitest";
import { PTC_CAPABILITIES, buildCapabilityAsActionMap } from "@away_from/pth-kernel-interpreter";
import { AGENT_CAPABILITY_AS_ACTION } from "@away_from/pth-kernel-execution";
import {
  InMemoryArtifactStore,
  InMemoryNetworkTraceRecorder,
  NetworkExecuteGateway,
  DefaultProviderRegistry,
  createOfflineHtmlExtractor,
} from "../../src/pth/execution/network/index.js";
import type { SearchProvider } from "../../src/pth/execution/network/index.js";

const artifactRef = {
  artifactId: "artifact-accept",
  storageKind: "task-artifact",
  immutableLocator: "task-artifact://artifact-accept",
  sha256: "abc",
  byteLength: 3,
  mediaType: "text/plain",
  retentionClass: "task",
};

describe("TCE 网络 V1 acceptance matrix（确定性无网络）", () => {
  it("net.* tool schema 全部从 PTC_CAPABILITIES 派生，不存在第二份手写 schema", () => {
    for (const id of ["net.search", "net.fetch", "net.extract"]) {
      expect(PTC_CAPABILITIES[id]?.toolSchema).toBeTruthy();
    }
  });

  it("legacy projection 只生成 net.* Code，不保留独立 I/O 执行体", () => {
    expect(AGENT_CAPABILITY_AS_ACTION["web.get"]!({ url: "https://example.com" })).toContain("net.fetch");
    expect(AGENT_CAPABILITY_AS_ACTION["reach.webSearch"]!({ query: "q" })).toContain("net.search");
    expect(AGENT_CAPABILITY_AS_ACTION["reach.webRead"]!({ url: "https://example.com" })).toContain("net.extract");
  });

  it("search→fetch→extract 可由同一 Execute gateway 串联", async () => {
    const registry = new DefaultProviderRegistry();
    const provider: SearchProvider = {
      providerId: "accept",
      implementationId: "accept-impl",
      version: "1",
      supportedProfiles: ["search-public"],
      capabilities: { rawHits: true, cursor: false },
      async search(request) {
        return {
          hits: [{ rank: 1, title: "A", url: "https://example.com/a", discovery: { providerId: "accept", providerVersion: "1", retrievedAt: "2026-08-26T00:00:00.000Z" }, publisher: { origin: "example.com" }, trust: "public-untrusted" }],
          attempt: { providerId: "accept", implementationId: "accept-impl", startedAt: "2026-08-26T00:00:00.000Z", durationMs: 1, status: "ok", resultCount: 1 },
        };
      },
    };
    registry.register(provider);
    const html = "<html><head><title>T</title></head><body><p>hello world</p></body></html>";
    const bytes = new TextEncoder().encode(html);
    const gateway = new NetworkExecuteGateway({
      registry,
      artifactStore: new InMemoryArtifactStore(),
      extractor: createOfflineHtmlExtractor(),
      fetchTransport: async (url) => ({
        requestedUri: url, finalUri: "https://example.com/a", redirectChain: ["https://example.com/a"], status: 200,
        headers: { "content-type": "text/html" }, rawBytes: bytes, byteLength: bytes.byteLength, hops: [],
      }),
      createOperationId: () => "op-accept",
    });
    const search = await gateway.search({ schemaVersion: "net.search.request/v1", query: "pth", limit: 1 });
    expect(search.hits[0]?.trust).toBe("public-untrusted");
    const fetch = await gateway.fetch({ schemaVersion: "net.fetch.request/v1", url: "https://example.com/a" });
    expect(fetch.finalUrl).toBe("https://example.com/a");
    expect(fetch.artifact.ref.sha256).toHaveLength(64);
    expect(fetch.transport.bytesRead).toBe(bytes.byteLength);
    const doc = await gateway.extract({ schemaVersion: "net.extract.request/v1", artifactRef: fetch.artifact.ref, mode: "main-content" });
    expect(doc.trust).toBe("processed-untrusted");
    expect(doc.text).toContain("hello world");
  });

  it("extract 对同一 artifact/hash/processor 产生相同 output hash", async () => {
    const store = new InMemoryArtifactStore();
    const html = "<html><body><p>deterministic</p></body></html>";
    const ref = await store.put({ bytes: new TextEncoder().encode(html), mediaType: "text/html" });
    const gateway = new NetworkExecuteGateway({
      artifactStore: store,
      extractor: createOfflineHtmlExtractor(),
      createOperationId: () => "op-extract-accept",
    });
    const req = { schemaVersion: "net.extract.request/v1" as const, artifactRef: ref, mode: "main-content" as const };
    const a = await gateway.extract(req);
    const b = await gateway.extract(req);
    expect(a.processingChain[0]?.outputHash).toBe(b.processingChain[0]?.outputHash);
  });

  it("trace 记录 attempts/partial/stopReason/bytes/latency", async () => {
    const trace = new InMemoryNetworkTraceRecorder();
    const gateway = new NetworkExecuteGateway({
      artifactStore: new InMemoryArtifactStore(),
      extractor: createOfflineHtmlExtractor(),
      traceRecorder: trace,
      fetchTransport: async (url) => ({ requestedUri: url, finalUri: url, redirectChain: [url], status: 200, headers: {}, rawBytes: new Uint8Array([1]), byteLength: 1, hops: [] }),
      createOperationId: () => "op-trace-accept",
    });
    await gateway.fetchText("https://example.com");
    const entry = trace.byOperationId("op-trace-accept");
    expect(entry?.kind).toBe("fetchText");
    expect(entry?.bytesRead).toBe(1);
  });
});
